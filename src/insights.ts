// Métricas para el dueño: resumen de actividad y agenda del día.
import { agenda } from "./config.js";
import { aMinutos, diaDeLaSemana, fechaLocal, sumarDias } from "./fechas.js";
import * as memoria from "./memoria.js";

export type Periodo = "hoy" | "semana" | "mes";
const DIAS_PERIODO: Record<Periodo, number> = { hoy: 1, semana: 7, mes: 30 };

const pesos = (n: number) => `$${Math.round(n).toLocaleString("es-AR")}`;
const pct = (parte: number, total: number) => (total ? `${Math.round((parte / total) * 100)}%` : "—");

function contar(valores: string[]): [string, number][] {
  const conteo = new Map<string, number>();
  for (const v of valores) conteo.set(v, (conteo.get(v) ?? 0) + 1);
  return [...conteo].sort((a, b) => b[1] - a[1]);
}

function minutosAbiertos(fecha: string): number {
  if (agenda.diasCerrado.includes(fecha) || memoria.diaCerrado(fecha)) return 0;
  return (agenda.horarios[diaDeLaSemana(fecha)] ?? []).reduce((s, [a, c]) => s + aMinutos(c) - aMinutos(a), 0);
}

export function resumen(periodo: Periodo): string {
  const hoy = fechaLocal(new Date());
  const desde = sumarDias(hoy, 1 - DIAS_PERIODO[periodo]);
  const hasta = sumarDias(hoy, 1);
  const eventos = memoria.eventosEntre(desde, hasta);
  const de = (tipo: memoria.TipoEvento) => eventos.filter((e) => e.tipo === tipo);

  const mensajes = de("mensaje");
  const clientes = new Set(mensajes.map((e) => e.telefono)).size;
  const agendados = de("turno").length;
  const cancelados = de("cancelacion").length;
  const derivaciones = de("derivacion");
  const sinLugar = de("sin_lugar");

  // La agenda del período: turnos que caen en esos días (agendados por el agente o antes).
  const turnos = memoria.turnosEntre(desde, hasta);
  const ocupado = turnos.reduce((s, t) => s + aMinutos(t.fin.slice(11)) - aMinutos(t.inicio.slice(11)), 0);
  let abierto = 0;
  for (let f = desde; f < hasta; f = sumarDias(f, 1)) abierto += minutosAbiertos(f);
  const facturacion = turnos.reduce((s, t) => s + (agenda.precios?.[t.servicio] ?? 0), 0);
  const servicios = contar(turnos.map((t) => t.servicio)).slice(0, 3);
  const franja = contar(turnos.map((t) => t.inicio.slice(11, 13)))[0];

  const titulo = { hoy: "de hoy", semana: "de los últimos 7 días", mes: "de los últimos 30 días" }[periodo];
  const lineas = [
    `📊 *Resumen ${titulo}*`,
    "",
    `💬 Mensajes: ${mensajes.length} de ${clientes} clientes (${memoria.clientesNuevosEntre(desde, hasta)} nuevos)`,
    `📅 Turnos agendados por el agente: ${agendados} · cancelados: ${cancelados}`,
    `🛍️ Pedidos: ${de("pedido").length}`,
    `🙋 Derivados a vos: ${derivaciones.length} (${pct(new Set(derivaciones.map((e) => e.telefono)).size, clientes)} de los clientes)`,
  ];
  if (sinLugar.length) {
    const detalle = contar(sinLugar.map((e) => e.detalle ?? "?"))
      .map(([s, n]) => `${s} ×${n}`)
      .join(", ");
    lineas.push(`🚫 Buscaron turno y no había lugar: ${sinLugar.length} (${detalle})`);
  }
  lineas.push(
    "",
    `*Agenda del período*: ${turnos.length} turnos · ocupación ${pct(ocupado, abierto)}`,
  );
  if (agenda.precios) lineas.push(`💰 Facturación estimada: ${pesos(facturacion)}`);
  if (servicios.length) lineas.push(`⭐ Más pedidos: ${servicios.map(([s, n]) => `${s} (${n})`).join(", ")}`);
  if (franja) lineas.push(`⏰ Horario con más turnos: ${franja}:00 a ${Number(franja) + 1}:00`);

  if (derivaciones.length) {
    lineas.push("", "*Lo que el agente no pudo resolver* (sumalo a negocio.md si se repite):");
    for (const e of derivaciones.slice(-5)) lineas.push(`• ${e.detalle}`);
  }
  return lineas.join("\n");
}

export function agendaDelDia(fecha: string): string {
  const turnos = memoria.turnosDelDia(fecha);
  const encabezado = `📅 *Agenda del ${diaDeLaSemana(fecha)} ${fecha}*`;
  if (!turnos.length) return `${encabezado}\nSin turnos.`;
  return [
    encabezado,
    ...turnos.map((t) => `${t.inicio.slice(11)} · ${t.servicio} · ${t.nombre} (#${t.id}, +${memoria.telefonoDeTurno(t.id)})`),
  ].join("\n");
}
