import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { agenda } from "./config.js";
import { aHora, aMinutos, diaDeLaSemana, fechaHoraLocal, fechaLocal } from "./fechas.js";
import * as memoria from "./memoria.js";
import { avisarAlDueno } from "./whatsapp.js";

/** Datos del cliente que la herramienta recibe del sistema, no del modelo. */
export type Contexto = { telefono: string; nombreWhatsapp: string | null };

type Herramienta<S extends z.ZodType> = {
  nombre: string;
  descripcion: string;
  esquema: S;
  ejecutar: (input: z.infer<S>, ctx: Contexto) => Promise<string> | string;
};

const definir = <S extends z.ZodType>(h: Herramienta<S>) => h;

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha en formato AAAA-MM-DD");
const servicio = z.enum(Object.keys(agenda.servicios) as [string, ...string[]]).describe("Servicio pedido");

function horariosLibres(dia: string, nombreServicio: string): string[] {
  const duracion = agenda.servicios[nombreServicio];
  if (agenda.diasCerrado.includes(dia)) return [];

  const ocupados = memoria.turnosDelDia(dia).map((t) => [aMinutos(t.inicio.slice(11)), aMinutos(t.fin.slice(11))]);
  const ahora = new Date();
  const minimo = dia === fechaLocal(ahora) ? ahora.getHours() * 60 + ahora.getMinutes() : -1;

  const libres: string[] = [];
  for (const [abre, cierra] of agenda.horarios[diaDeLaSemana(dia)] ?? []) {
    for (let ini = aMinutos(abre); ini + duracion <= aMinutos(cierra); ini += agenda.intervaloMinutos) {
      const fin = ini + duracion;
      if (ini <= minimo) continue;
      if (ocupados.some(([o1, o2]) => ini < o2 && fin > o1)) continue;
      libres.push(aHora(ini));
    }
  }
  return libres;
}

const herramientas = [
  definir({
    nombre: "consultar_disponibilidad",
    descripcion:
      "Devuelve los horarios libres para un servicio en una fecha. Usala siempre antes de ofrecer o agendar un turno.",
    esquema: z.strictObject({ fecha, servicio }),
    ejecutar: ({ fecha, servicio }, ctx) => {
      if (fecha < fechaLocal(new Date())) return "Esa fecha ya pasó.";
      const libres = horariosLibres(fecha, servicio);
      if (!libres.length) memoria.registrarEvento("sin_lugar", ctx.telefono, servicio);
      return libres.length
        ? `Horarios libres el ${diaDeLaSemana(fecha)} ${fecha} para ${servicio}: ${libres.join(", ")}`
        : `No hay horarios libres el ${diaDeLaSemana(fecha)} ${fecha} para ${servicio} (cerrado o completo).`;
    },
  }),

  definir({
    nombre: "agendar_turno",
    descripcion:
      "Reserva un turno. Solo usala cuando el cliente confirmó explícitamente servicio, fecha, hora y su nombre.",
    esquema: z.strictObject({
      fecha,
      hora: z.string().regex(/^\d{2}:\d{2}$/).describe("Hora de inicio HH:MM"),
      servicio,
      nombre: z.string().describe("Nombre del cliente"),
    }),
    ejecutar: async ({ fecha, hora, servicio, nombre }, ctx) => {
      if (!horariosLibres(fecha, servicio).includes(hora)) {
        return `El horario ${hora} del ${fecha} no está disponible. Consultá la disponibilidad de nuevo.`;
      }
      const inicio = `${fecha}T${hora}`;
      const fin = `${fecha}T${aHora(aMinutos(hora) + agenda.servicios[servicio])}`;
      const id = memoria.crearTurno({ telefono: ctx.telefono, nombre, servicio, inicio, fin });
      memoria.registrarEvento("turno", ctx.telefono, servicio);
      await avisarAlDueno(`📅 Nuevo turno #${id}: ${nombre} (+${ctx.telefono}) — ${servicio}, ${diaDeLaSemana(fecha)} ${fecha} ${hora}`);
      return `Turno #${id} confirmado: ${servicio} el ${diaDeLaSemana(fecha)} ${fecha} a las ${hora} a nombre de ${nombre}.`;
    },
  }),

  definir({
    nombre: "ver_mis_turnos",
    descripcion: "Lista los próximos turnos confirmados del cliente que está escribiendo.",
    esquema: z.strictObject({}),
    ejecutar: (_input, ctx) => {
      const turnos = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(new Date()));
      return turnos.length
        ? turnos.map((t) => `#${t.id}: ${t.servicio}, ${diaDeLaSemana(t.inicio.slice(0, 10))} ${t.inicio.replace("T", " ")}`).join("\n")
        : "El cliente no tiene turnos próximos.";
    },
  }),

  definir({
    nombre: "cancelar_turno",
    descripcion: "Cancela un turno del cliente. Confirmá con el cliente antes de cancelar.",
    esquema: z.strictObject({ turno_id: z.number().int().describe("Número del turno, obtenido de ver_mis_turnos") }),
    ejecutar: async ({ turno_id }, ctx) => {
      const ahora = new Date();
      const proximo = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(ahora)).find((t) => t.id === turno_id);
      if (!proximo) return "No encontré ese turno entre los próximos turnos de este cliente.";

      const horas = agenda.anticipacionCancelarHoras ?? 0;
      if (horas && proximo.inicio < fechaHoraLocal(new Date(ahora.getTime() + horas * 3600_000))) {
        return `Faltan menos de ${horas} h para el turno y la política no permite cancelarlo por acá. Ofrecé derivar a una persona.`;
      }

      const turno = memoria.cancelarTurno(turno_id, ctx.telefono);
      if (!turno) return "No encontré ese turno entre los turnos de este cliente.";
      memoria.registrarEvento("cancelacion", ctx.telefono, turno.servicio);
      await avisarAlDueno(`❌ Turno #${turno.id} cancelado: ${turno.nombre} — ${turno.servicio}, ${turno.inicio.replace("T", " ")}`);
      return `Turno #${turno.id} cancelado.`;
    },
  }),

  definir({
    nombre: "tomar_pedido",
    descripcion:
      "Registra un pedido de productos del negocio y avisa al dueño. Usala cuando el cliente confirmó qué quiere y su nombre.",
    esquema: z.strictObject({
      nombre: z.string().describe("Nombre del cliente"),
      detalle: z.string().describe("Productos, cantidades y cualquier aclaración (retiro, horario, etc.)"),
    }),
    ejecutar: async ({ nombre, detalle }, ctx) => {
      const id = memoria.crearPedido(ctx.telefono, nombre, detalle, fechaHoraLocal(new Date()));
      memoria.registrarEvento("pedido", ctx.telefono, detalle);
      await avisarAlDueno(`🛍️ Pedido #${id} de ${nombre} (+${ctx.telefono}):\n${detalle}`);
      return `Pedido #${id} registrado. El dueño ya fue avisado.`;
    },
  }),

  definir({
    nombre: "derivar_a_humano",
    descripcion:
      "Pasa la conversación a una persona del negocio. Usala si el cliente lo pide, está molesto, o preguntás algo que no está en la información del negocio.",
    esquema: z.strictObject({ motivo: z.string().describe("Resumen breve de qué necesita el cliente") }),
    ejecutar: async ({ motivo }, ctx) => {
      memoria.cambiarModo(ctx.telefono, "humano");
      memoria.registrarEvento("derivacion", ctx.telefono, motivo);
      await avisarAlDueno(
        `🙋 ${ctx.nombreWhatsapp ?? "Un cliente"} (+${ctx.telefono}) necesita atención: ${motivo}\n\n` +
          `Respondé con: /responder ${ctx.telefono} <mensaje>\nCuando termines: /reactivar ${ctx.telefono}`,
      );
      return "Conversación derivada. Avisale al cliente que en breve le responde una persona.";
    },
  }),
];

export const definicionesHerramientas: Anthropic.Beta.BetaTool[] = herramientas.map((h) => {
  const { $schema: _, ...schema } = z.toJSONSchema(h.esquema) as Record<string, unknown>;
  return {
    name: h.nombre,
    description: h.descripcion,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    strict: true,
  };
});

export async function ejecutarHerramienta(nombre: string, input: unknown, ctx: Contexto) {
  const h = herramientas.find((x) => x.nombre === nombre);
  if (!h) return { contenido: `Herramienta desconocida: ${nombre}`, error: true };

  const parsed = h.esquema.safeParse(input);
  if (!parsed.success) return { contenido: `Datos inválidos: ${parsed.error.message}`, error: true };

  try {
    return { contenido: await h.ejecutar(parsed.data as never, ctx), error: false };
  } catch (e) {
    console.error(`Error en ${nombre}:`, e);
    return { contenido: "Error interno al ejecutar la acción.", error: true };
  }
}
