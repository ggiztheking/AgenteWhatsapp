import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { fechaHoraLocal } from "./fechas.js";

type Mensaje = Anthropic.Beta.BetaMessageParam;
export type Modo = "agente" | "humano";

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS conversaciones (
    telefono TEXT PRIMARY KEY,
    nombre TEXT,
    mensajes TEXT NOT NULL DEFAULT '[]',
    modo TEXT NOT NULL DEFAULT 'agente',
    actualizado INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turnos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT NOT NULL,
    nombre TEXT NOT NULL,
    servicio TEXT NOT NULL,
    inicio TEXT NOT NULL,
    fin TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'confirmado'
  );
  CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono TEXT NOT NULL,
    nombre TEXT NOT NULL,
    detalle TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'nuevo',
    creado TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mensajes_procesados (
    id TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    telefono TEXT,
    detalle TEXT,
    fecha TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS eventos_fecha ON eventos (fecha);
  CREATE TABLE IF NOT EXISTS dias_cerrados (
    fecha TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS avisos_pendientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    texto TEXT NOT NULL
  );
`);

// Columnas agregadas después de la primera versión: se suman a las bases que ya existen.
const columnasTurnos = (db.prepare("PRAGMA table_info(turnos)").all() as { name: string }[]).map((c) => c.name);
for (const [columna, tipo] of [
  ["recordado", "INTEGER NOT NULL DEFAULT 0"],
  ["evento_calendario", "TEXT"],
  ["pago", "TEXT"],
  // Turnos reservados en la agenda de barberia-saas: su código allá, el barbero y el precio que calculó.
  ["codigo", "TEXT"],
  ["barbero", "TEXT"],
  ["precio", "REAL"],
]) {
  if (!columnasTurnos.includes(columna)) db.exec(`ALTER TABLE turnos ADD COLUMN ${columna} ${tipo}`);
}

type FilaConversacion = { nombre: string | null; mensajes: string; modo: Modo; actualizado: number };

export function cargarConversacion(telefono: string) {
  const fila = db
    .prepare("SELECT nombre, mensajes, modo, actualizado FROM conversaciones WHERE telefono = ?")
    .get(telefono) as FilaConversacion | undefined;
  if (!fila) return { nombre: null, mensajes: [] as Mensaje[], modo: "agente" as Modo };

  // El historial solo se agrega al final, nunca se edita: si la charla quedó vieja, empieza una nueva.
  const vencida = Date.now() - fila.actualizado > config.horasParaNuevaConversacion * 3600_000;
  return {
    nombre: fila.nombre,
    mensajes: vencida ? [] : (JSON.parse(fila.mensajes) as Mensaje[]),
    modo: fila.modo,
  };
}

export function guardarConversacion(telefono: string, nombre: string | null, mensajes: Mensaje[]) {
  db.prepare(
    `INSERT INTO conversaciones (telefono, nombre, mensajes, actualizado) VALUES (?, ?, ?, ?)
     ON CONFLICT(telefono) DO UPDATE SET nombre = excluded.nombre, mensajes = excluded.mensajes, actualizado = excluded.actualizado`,
  ).run(telefono, nombre, JSON.stringify(mensajes), Date.now());
}

export function obtenerModo(telefono: string): Modo {
  const fila = db.prepare("SELECT modo FROM conversaciones WHERE telefono = ?").get(telefono) as
    | { modo: Modo }
    | undefined;
  return fila?.modo ?? "agente";
}

export function cambiarModo(telefono: string, modo: Modo) {
  db.prepare(
    `INSERT INTO conversaciones (telefono, modo, actualizado) VALUES (?, ?, ?)
     ON CONFLICT(telefono) DO UPDATE SET modo = excluded.modo`,
  ).run(telefono, modo, Date.now());
}

/**
 * Agrega al historial algo que pasó fuera del agente (mensajes con una persona del negocio),
 * para que el agente tenga el contexto cuando vuelva a atender.
 */
export function agregarNota(telefono: string, texto: string) {
  const conv = cargarConversacion(telefono);
  conv.mensajes.push({ role: "user", content: texto });
  guardarConversacion(telefono, conv.nombre, conv.mensajes);
}

/** Devuelve true la primera vez que ve un id; WhatsApp a veces reenvía el mismo webhook. */
export function marcarProcesado(idMensaje: string): boolean {
  const r = db.prepare("INSERT OR IGNORE INTO mensajes_procesados (id) VALUES (?)").run(idMensaje);
  return r.changes > 0;
}

// --- Turnos ---

export type Turno = { id: number; nombre: string; servicio: string; inicio: string; fin: string; barbero?: string | null };

export function turnosDelDia(fecha: string): Turno[] {
  return db
    .prepare(
      "SELECT id, nombre, servicio, inicio, fin, barbero FROM turnos WHERE estado = 'confirmado' AND inicio LIKE ? ORDER BY inicio",
    )
    .all(`${fecha}%`) as Turno[];
}

export function turnosFuturosDe(telefono: string, desde: string): (Turno & { codigo: string | null })[] {
  return db
    .prepare(
      "SELECT id, nombre, servicio, inicio, fin, barbero, codigo FROM turnos WHERE estado = 'confirmado' AND telefono = ? AND inicio >= ? ORDER BY inicio",
    )
    .all(telefono, desde) as never;
}

export function crearTurno(
  t: Omit<Turno, "id"> & { telefono: string; recordado?: boolean; codigo?: string; precio?: number },
): number {
  const r = db
    .prepare(
      "INSERT INTO turnos (telefono, nombre, servicio, inicio, fin, recordado, codigo, barbero, precio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(t.telefono, t.nombre, t.servicio, t.inicio, t.fin, t.recordado ? 1 : 0, t.codigo ?? null, t.barbero ?? null, t.precio ?? null);
  return Number(r.lastInsertRowid);
}

export function turnoPorId(
  id: number,
): (Turno & { telefono: string; pago: string | null; evento_calendario: string | null; codigo: string | null; precio: number | null }) | undefined {
  return db
    .prepare(
      "SELECT id, telefono, nombre, servicio, inicio, fin, barbero, pago, evento_calendario, codigo, precio FROM turnos WHERE id = ? AND estado = 'confirmado'",
    )
    .get(id) as never;
}

export function actualizarTurno(id: number, campo: "evento_calendario" | "pago" | "recordado", valor: string | number) {
  db.prepare(`UPDATE turnos SET ${campo} = ? WHERE id = ?`).run(valor, id);
}

/** Turnos confirmados entre dos momentos que todavía no recibieron recordatorio. */
export function turnosParaRecordar(desde: string, hasta: string): (Turno & { telefono: string })[] {
  return db
    .prepare(
      `SELECT id, telefono, nombre, servicio, inicio, fin FROM turnos
       WHERE estado = 'confirmado' AND recordado = 0 AND inicio > ? AND inicio <= ? ORDER BY inicio`,
    )
    .all(desde, hasta) as never;
}

export function turnosEntre(desde: string, hasta: string): (Turno & { precio: number | null })[] {
  return db
    .prepare(
      "SELECT id, nombre, servicio, inicio, fin, barbero, precio FROM turnos WHERE estado = 'confirmado' AND inicio >= ? AND inicio < ? ORDER BY inicio",
    )
    .all(desde, hasta) as never;
}

export function telefonoDeTurno(id: number): string | undefined {
  return (db.prepare("SELECT telefono FROM turnos WHERE id = ?").get(id) as { telefono: string } | undefined)?.telefono;
}

export function cancelarTurno(id: number, telefono: string): Turno | undefined {
  const turno = db
    .prepare(
      "SELECT id, nombre, servicio, inicio, fin FROM turnos WHERE id = ? AND telefono = ? AND estado = 'confirmado'",
    )
    .get(id, telefono) as Turno | undefined;
  if (turno) db.prepare("UPDATE turnos SET estado = 'cancelado' WHERE id = ?").run(id);
  return turno;
}

// --- Pedidos ---

export function crearPedido(telefono: string, nombre: string, detalle: string, creado: string): number {
  const r = db
    .prepare("INSERT INTO pedidos (telefono, nombre, detalle, creado) VALUES (?, ?, ?, ?)")
    .run(telefono, nombre, detalle, creado);
  return Number(r.lastInsertRowid);
}

// --- Eventos (para las métricas del dueño) ---

export type TipoEvento = "mensaje" | "turno" | "cancelacion" | "pedido" | "derivacion" | "sin_lugar";
export type Evento = { tipo: TipoEvento; telefono: string | null; detalle: string | null; fecha: string };

export function registrarEvento(tipo: TipoEvento, telefono: string | null, detalle: string | null = null) {
  db.prepare("INSERT INTO eventos (tipo, telefono, detalle, fecha) VALUES (?, ?, ?, ?)").run(
    tipo,
    telefono,
    detalle,
    fechaHoraLocal(new Date()),
  );
}

export function eventosEntre(desde: string, hasta: string): Evento[] {
  return db
    .prepare("SELECT tipo, telefono, detalle, fecha FROM eventos WHERE fecha >= ? AND fecha < ? ORDER BY fecha")
    .all(desde, hasta) as Evento[];
}

/** Clientes cuyo primer mensaje cae dentro del período. */
export function clientesNuevosEntre(desde: string, hasta: string): number {
  const fila = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (SELECT MIN(fecha) AS primero FROM eventos WHERE tipo = 'mensaje' GROUP BY telefono)
       WHERE primero >= ? AND primero < ?`,
    )
    .get(desde, hasta) as { n: number };
  return Number(fila.n);
}

// --- Días cerrados que el dueño carga por WhatsApp (se suman a los de agenda.json) ---

export function diaCerrado(fecha: string): boolean {
  return !!db.prepare("SELECT 1 FROM dias_cerrados WHERE fecha = ?").get(fecha);
}

export function cerrarDia(fecha: string, cerrado: boolean) {
  if (cerrado) db.prepare("INSERT OR IGNORE INTO dias_cerrados (fecha) VALUES (?)").run(fecha);
  else db.prepare("DELETE FROM dias_cerrados WHERE fecha = ?").run(fecha);
}

// --- Avisos al dueño que no se pudieron entregar (fuera de la ventana de 24 h) ---

export function guardarAvisoPendiente(texto: string) {
  db.prepare("INSERT INTO avisos_pendientes (texto) VALUES (?)").run(texto);
}

export function hayAvisosPendientes(): boolean {
  return !!db.prepare("SELECT 1 FROM avisos_pendientes LIMIT 1").get();
}

export function tomarAvisosPendientes(): string[] {
  const filas = db.prepare("SELECT id, texto FROM avisos_pendientes ORDER BY id").all() as { id: number; texto: string }[];
  if (filas.length) db.prepare("DELETE FROM avisos_pendientes WHERE id <= ?").run(filas.at(-1)!.id);
  return filas.map((f) => f.texto);
}

// --- Respaldo ---

/** Copia la base a data/respaldos/agente-AAAA-MM-DD.db y deja solo los últimos `conservar`. */
export function respaldar(fecha: string, conservar = 7): string | null {
  if (config.dbPath === ":memory:") return null;
  const carpeta = join(dirname(config.dbPath), "respaldos");
  mkdirSync(carpeta, { recursive: true });
  const destino = join(carpeta, `agente-${fecha}.db`);
  rmSync(destino, { force: true });
  db.exec(`VACUUM INTO '${destino.replaceAll("'", "''")}'`);
  const viejos = readdirSync(carpeta).filter((f) => /^agente-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -conservar);
  for (const f of viejos) rmSync(join(carpeta, f));
  return destino;
}
