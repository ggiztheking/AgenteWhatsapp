import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

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
`);

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

/** Devuelve true la primera vez que ve un id; WhatsApp a veces reenvía el mismo webhook. */
export function marcarProcesado(idMensaje: string): boolean {
  const r = db.prepare("INSERT OR IGNORE INTO mensajes_procesados (id) VALUES (?)").run(idMensaje);
  return r.changes > 0;
}

// --- Turnos ---

export type Turno = { id: number; nombre: string; servicio: string; inicio: string; fin: string };

export function turnosDelDia(fecha: string): Turno[] {
  return db
    .prepare(
      "SELECT id, nombre, servicio, inicio, fin FROM turnos WHERE estado = 'confirmado' AND inicio LIKE ? ORDER BY inicio",
    )
    .all(`${fecha}%`) as Turno[];
}

export function turnosFuturosDe(telefono: string, desde: string): Turno[] {
  return db
    .prepare(
      "SELECT id, nombre, servicio, inicio, fin FROM turnos WHERE estado = 'confirmado' AND telefono = ? AND inicio >= ? ORDER BY inicio",
    )
    .all(telefono, desde) as Turno[];
}

export function crearTurno(t: Omit<Turno, "id"> & { telefono: string }): number {
  const r = db
    .prepare("INSERT INTO turnos (telefono, nombre, servicio, inicio, fin) VALUES (?, ?, ?, ?, ?)")
    .run(t.telefono, t.nombre, t.servicio, t.inicio, t.fin);
  return Number(r.lastInsertRowid);
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
