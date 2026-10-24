// Cliente de la agenda de barberia-saas (la misma que usa la página web del negocio).
// Usa solo las rutas públicas de reserva: /info, /paquetes, /horarios, /citas, /mis-citas y /cancelar.
import { config } from "./config.js";
import { aMinutos, fechaHoraLocal } from "./fechas.js";

export const barberiaActiva = () => !!config.barberia.url;

/** Error que devuelve la agenda con un mensaje pensado para el cliente ("Ese horario ya se ocupó..."). */
export class ErrorAgenda extends Error {
  constructor(
    readonly estado: number,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

async function llamar<T>(ruta: string, cuerpo?: object): Promise<T> {
  const res = await fetch(`${config.barberia.url}/api/${encodeURIComponent(config.barberia.slug)}${ruta}`, {
    method: cuerpo ? "POST" : "GET",
    headers: cuerpo ? { "Content-Type": "application/json" } : undefined,
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const datos = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ErrorAgenda(res.status, datos.error || `La agenda respondió ${res.status}`);
  return datos;
}

export type Info = { barberos: string[]; horas: string[]; intervalo: number; cierra: string; abierto: boolean };
export type Catalogo = {
  paquetes: { id: number; nombre: string; precio: number; incluye: string[]; lavado: boolean }[];
  extras: { id: number; nombre: string; precio: number; lavado: boolean }[];
};

// El horario, los barberos y el catálogo cambian poco: se guardan 5 minutos para no consultarlos en cada mensaje.
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { vence: number; valor: Promise<unknown> }>();
function guardado<T>(clave: string, buscar: () => Promise<T>): Promise<T> {
  const c = cache.get(clave);
  if (c && c.vence > Date.now()) return c.valor as Promise<T>;
  const valor = buscar();
  cache.set(clave, { vence: Date.now() + CACHE_MS, valor });
  valor.catch(() => cache.delete(clave));
  return valor;
}

export const info = () => guardado("info", () => llamar<Info>("/info"));
export const catalogo = () => guardado("catalogo", () => llamar<Catalogo>("/paquetes"));

/** Mismo criterio que la agenda web: `cierra` son los días de la semana cerrados ("0" = domingo). */
const diaCerrado = (i: Info, fecha: string) => (i.cierra || "").split(",").includes(String(new Date(`${fecha}T12:00`).getDay()));

/** Horarios libres de una fecha, con los barberos que tienen ese espacio libre. */
export async function horariosLibres(fecha: string, barbero?: string): Promise<{ hora: string; barberos: string[] }[]> {
  const i = await info();
  if (!i.abierto || diaCerrado(i, fecha)) return [];
  const lista = barbero ? i.barberos.filter((b) => b.toLowerCase() === barbero.toLowerCase()) : i.barberos;
  // /horarios devuelve los espacios OCUPADOS de ese barbero (cita, bloqueo o día cerrado).
  const ocupados = await Promise.all(
    lista.map(async (b) => new Set(await llamar<string[]>(`/horarios?fecha=${fecha}&barbero=${encodeURIComponent(b)}`))),
  );
  const ahora = fechaHoraLocal(new Date());
  return i.horas
    .filter((h) => `${fecha}T${h}` > ahora)
    .map((hora) => ({ hora, barberos: lista.filter((_, k) => !ocupados[k].has(hora)) }))
    .filter((x) => x.barberos.length);
}

export type Reserva = { codigo: string; precio: number; barbero: string };

export async function reservar(datos: {
  cliente: string;
  telefono: string;
  servicio: string;
  extras: number[];
  fecha: string;
  hora: string;
  barbero: string;
}): Promise<Reserva> {
  const r = await llamar<{ codigo: string; precio: string | number; barbero: string }>("/citas", datos);
  return { codigo: r.codigo, precio: Number(r.precio), barbero: r.barbero };
}

export type Cita = { codigo: string; servicio: string; barbero: string; fecha: string; hora: string; precio: number; estado: string };

export async function citas(codigos: string[]): Promise<Cita[]> {
  if (!codigos.length) return [];
  return (await llamar<Cita[]>("/mis-citas", { codigos })).map((c) => ({ ...c, precio: Number(c.precio) }));
}

export async function cancelar(codigo: string): Promise<void> {
  await llamar("/cancelar", { codigo });
}

/** Fin de una cita: en la agenda web cada cita ocupa un espacio del intervalo. */
export async function finDeCita(fecha: string, hora: string): Promise<string> {
  const { intervalo } = await info();
  const fin = Math.min(aMinutos(hora) + (intervalo || 60), 23 * 60 + 59);
  return `${fecha}T${String(Math.floor(fin / 60)).padStart(2, "0")}:${String(fin % 60).padStart(2, "0")}`;
}
