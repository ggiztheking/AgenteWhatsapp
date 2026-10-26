import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as barberia from "./barberia.js";
import { agenda, config } from "./config.js";
import { aHora, aMinutos, diaDeLaSemana, fechaHoraLocal, fechaLocal } from "./fechas.js";
import { agregarAlCalendario, linkDeSena, quitarDelCalendario } from "./integraciones.js";
import * as memoria from "./memoria.js";
import { avisarAlDueno, escribirAlCliente } from "./whatsapp.js";

/** Datos del cliente que la herramienta recibe del sistema, no del modelo. */
export type Contexto = { telefono: string; nombreWhatsapp: string | null };

type Herramienta<S extends z.ZodType> = {
  nombre: string;
  descripcion: string;
  esquema: S;
  ejecutar: (input: z.infer<S>, ctx: Contexto) => Promise<string> | string;
};

const definir = <S extends z.ZodType>(h: Herramienta<S>) => h;

export const dinero = (n: number) => `$${Math.round(n).toLocaleString("es-MX")} ${config.moneda}`;
const cuando = (inicio: string) => `${diaDeLaSemana(inicio.slice(0, 10))} ${inicio.slice(0, 10)} a las ${inicio.slice(11)}`;

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha en formato AAAA-MM-DD");
const hora = z.string().regex(/^\d{2}:\d{2}$/).describe("Hora de inicio HH:MM, tal como salió en la disponibilidad");
const nombre = z.string().describe("Nombre del cliente");

// --- Agenda local (agenda.json + SQLite), cuando no hay barberia-saas configurada ---

const servicioLocal = z.enum(Object.keys(agenda.servicios) as [string, ...string[]]).describe("Servicio pedido");

function horariosLibresLocal(dia: string, nombreServicio: string, sinContar?: number): string[] {
  const duracion = agenda.servicios[nombreServicio] ?? Math.min(...Object.values(agenda.servicios));
  if (agenda.diasCerrado.includes(dia) || memoria.diaCerrado(dia)) return [];

  const ocupados = memoria
    .turnosDelDia(dia)
    .filter((t) => t.id !== sinContar)
    .map((t) => [aMinutos(t.inicio.slice(11)), aMinutos(t.fin.slice(11))]);
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

/** Horarios libres de un día en la agenda que esté activa (para la lista de espera). */
async function lugaresLibres(dia: string, barbero: string | null): Promise<string[]> {
  if (memoria.diaCerrado(dia)) return [];
  if (barberia.barberiaActiva()) return (await barberia.horariosLibres(dia, barbero ?? undefined)).map((l) => l.hora);
  const masCorto = Object.entries(agenda.servicios).sort((a, b) => a[1] - b[1])[0][0];
  return horariosLibresLocal(dia, masCorto);
}

/**
 * Se liberó lugar en un día (cancelación o cambio): se les avisa a todos los de la lista de espera de ese día
 * que tienen un horario libre que les sirve. El primero que conteste se lo queda.
 */
export async function ofrecerLugarLiberado(dia: string): Promise<void> {
  if (dia < fechaLocal(new Date())) return;
  let avisados = 0;
  for (const e of memoria.enEsperaPara(dia)) {
    try {
      const libres = (await lugaresLibres(dia, e.barbero)).slice(0, 3);
      if (!libres.length) continue;
      const nombreCliente = e.nombre ? ` ${e.nombre.split(" ")[0]}` : "";
      const conBarbero = e.barbero ? ` con ${e.barbero}` : "";
      const texto =
        `¡Hola${nombreCliente}! Se liberó un lugar el ${diaDeLaSemana(dia)} ${dia}${conBarbero}: ${libres.join(", ")}. ` +
        "¿Te lo aparto? Respóndeme y te lo agendo antes de que lo gane alguien más 💈";
      const parametros = [e.nombre?.split(" ")[0] ?? "", `${diaDeLaSemana(dia)} ${dia}`, libres.join(", ")];
      if (!(await escribirAlCliente(e.telefono, texto, config.whatsapp.plantillaLugarLibre, parametros))) continue;
      memoria.marcarAvisado(e.id);
      memoria.registrarEvento("lugar_ofrecido", e.telefono, dia);
      memoria.agregarNota(
        e.telefono,
        `[Aviso automático de la lista de espera: se le ofreció un lugar el ${dia}${conBarbero} (${libres.join(", ")}). ` +
          "Si contesta que sí, consulta la disponibilidad y agéndalo.]",
      );
      avisados++;
    } catch (err) {
      console.error(`Error avisando a la lista de espera (+${e.telefono}):`, err);
    }
  }
  if (avisados) await avisarAlDueno(`♻️ Se liberó lugar el ${diaDeLaSemana(dia)} ${dia}: le avisé a ${avisados} cliente(s) de la lista de espera.`);
}

// --- Lo que pasa después de reservar, en los dos modos ---

async function registrarReserva(
  ctx: Contexto,
  r: { nombre: string; servicio: string; inicio: string; fin: string; precio?: number; barbero?: string; codigo?: string },
): Promise<string> {
  // Si la cita es dentro de las próximas 26 h (la ventana del recordatorio) no hace falta mandárselo.
  const recordado = r.inicio <= fechaHoraLocal(new Date(Date.now() + 26 * 3600_000));
  const id = memoria.crearTurno({ telefono: ctx.telefono, ...r, recordado });
  memoria.registrarEvento("turno", ctx.telefono, r.servicio.split(" + ")[0]);
  // Venía de la lista de espera: es una cita rescatada de una cancelación.
  if (memoria.fueAvisado(ctx.telefono, r.inicio.slice(0, 10))) memoria.registrarEvento("rescatada", ctx.telefono, String(r.precio ?? 0));

  const turno = { id, nombre: r.nombre, servicio: r.servicio, inicio: r.inicio, fin: r.fin, barbero: r.barbero };
  const evento = await agregarAlCalendario({ ...turno, telefono: ctx.telefono });
  if (evento) memoria.actualizarTurno(id, "evento_calendario", evento);
  const sena = r.precio ? await linkDeSena(turno, r.precio) : null;
  if (sena) memoria.actualizarTurno(id, "pago", "pendiente");

  const conBarbero = r.barbero ? ` con ${r.barbero}` : "";
  const precio = r.precio ? ` · ${dinero(r.precio)}` : "";
  await avisarAlDueno(`📅 Nueva cita #${id}: ${r.nombre} (+${ctx.telefono}) — ${r.servicio}${conBarbero}, ${cuando(r.inicio)}${precio}`);
  const confirmada = `Cita #${id} confirmada: ${r.servicio}${conBarbero}, ${cuando(r.inicio)}, a nombre de ${r.nombre}${precio ? `. Total: ${dinero(r.precio!)}` : ""}.`;
  return sena
    ? `${confirmada} Pásale al cliente este link para pagar el anticipo de ${dinero(sena.monto)} con Mercado Pago (cópialo tal cual): ${sena.link}`
    : confirmada;
}

/** Cancela una cita (también en barberia-saas si se reservó ahí), la saca del calendario y la registra. */
export async function cancelar(id: number, telefono: string): Promise<memoria.Turno | undefined> {
  const datos = memoria.turnoPorId(id);
  if (!datos || datos.telefono !== telefono) return undefined;
  if (datos.codigo) {
    try {
      await barberia.cancelar(datos.codigo);
    } catch (e) {
      // 404: allá ya estaba cancelada o atendida; se cancela igual aquí para que no quede colgada.
      if (!(e instanceof barberia.ErrorAgenda && e.estado === 404)) throw e;
    }
  }
  const turno = memoria.cancelarTurno(id, telefono);
  if (!turno) return undefined;
  memoria.registrarEvento("cancelacion", telefono, turno.servicio.split(" + ")[0]);
  await quitarDelCalendario(datos.evento_calendario);
  await ofrecerLugarLiberado(turno.inicio.slice(0, 10));
  return turno;
}

/** La política de anticipación vale para cancelar y para cambiar la cita. */
function fueraDePlazo(inicio: string): string | null {
  const horas = agenda.anticipacionCancelarHoras ?? 0;
  if (horas && inicio < fechaHoraLocal(new Date(Date.now() + horas * 3600_000))) {
    return `Faltan menos de ${horas} h para la cita y la política no permite cancelarla ni cambiarla por aquí. Ofrécele pasar con una persona.`;
  }
  return null;
}

function respuestaDeError(e: unknown): string {
  if (!(e instanceof barberia.ErrorAgenda)) throw e;
  if (e.estado === 429) return "La agenda no está aceptando más reservas por ahora. Ofrécele pasar con una persona del negocio.";
  return `La agenda respondió: ${e.message}`;
}

// --- Herramientas de citas ---

const citasLocales = [
  definir({
    nombre: "consultar_disponibilidad",
    descripcion: "Devuelve los horarios libres para un servicio en una fecha. Úsala siempre antes de ofrecer o agendar una cita.",
    esquema: z.strictObject({ fecha, servicio: servicioLocal }),
    ejecutar: ({ fecha, servicio }, ctx) => {
      if (fecha < fechaLocal(new Date())) return "Esa fecha ya pasó.";
      const libres = horariosLibresLocal(fecha, servicio);
      if (!libres.length) memoria.registrarEvento("sin_lugar", ctx.telefono, servicio);
      return libres.length
        ? `Horarios libres el ${diaDeLaSemana(fecha)} ${fecha} para ${servicio}: ${libres.join(", ")}`
        : `No hay horarios libres el ${diaDeLaSemana(fecha)} ${fecha} para ${servicio} (cerrado o lleno).`;
    },
  }),

  definir({
    nombre: "agendar_cita",
    descripcion: "Reserva una cita. Úsala solo cuando el cliente confirmó explícitamente servicio, fecha, hora y su nombre.",
    esquema: z.strictObject({ fecha, hora, servicio: servicioLocal, nombre }),
    ejecutar: async ({ fecha, hora, servicio, nombre }, ctx) => {
      if (!horariosLibresLocal(fecha, servicio).includes(hora)) {
        return `El horario ${hora} del ${fecha} no está disponible. Vuelve a consultar la disponibilidad.`;
      }
      return registrarReserva(ctx, {
        nombre,
        servicio,
        inicio: `${fecha}T${hora}`,
        fin: `${fecha}T${aHora(aMinutos(hora) + agenda.servicios[servicio])}`,
        precio: agenda.precios?.[servicio],
      });
    },
  }),
];

const citasBarberia = [
  definir({
    nombre: "consultar_disponibilidad",
    descripcion:
      "Devuelve los horarios libres de una fecha en la agenda de la barbería, con los barberos libres en cada horario. " +
      "Úsala siempre antes de ofrecer o agendar una cita.",
    esquema: z.strictObject({
      fecha,
      barbero: z.string().describe('Nombre del barbero que pidió el cliente, o "cualquiera"'),
    }),
    ejecutar: async ({ fecha, barbero }, ctx) => {
      if (fecha < fechaLocal(new Date())) return "Esa fecha ya pasó.";
      if (memoria.diaCerrado(fecha)) return `El ${diaDeLaSemana(fecha)} ${fecha} la barbería está cerrada.`;
      try {
        const { barberos } = await barberia.info();
        const pedido = barbero.toLowerCase() === "cualquiera" ? undefined : barbero;
        if (pedido && !barberos.some((b) => b.toLowerCase() === pedido.toLowerCase())) {
          return `No hay un barbero llamado ${barbero}. Los barberos son: ${barberos.join(", ")}.`;
        }
        const libres = await barberia.horariosLibres(fecha, pedido);
        if (!libres.length) {
          memoria.registrarEvento("sin_lugar", ctx.telefono, pedido ?? "cualquiera");
          return `No hay horarios libres el ${diaDeLaSemana(fecha)} ${fecha}${pedido ? ` con ${pedido}` : ""} (cerrado o lleno).`;
        }
        return (
          `Horarios libres el ${diaDeLaSemana(fecha)} ${fecha}:\n` +
          libres.map((l) => `${l.hora} (${l.barberos.join(", ")})`).join("\n")
        );
      } catch (e) {
        return respuestaDeError(e);
      }
    },
  }),

  definir({
    nombre: "agendar_cita",
    descripcion:
      "Reserva una cita en la agenda de la barbería. Úsala solo cuando el cliente confirmó explícitamente paquete, " +
      "extras (si quiere), fecha, hora, barbero y su nombre.",
    esquema: z.strictObject({
      fecha,
      hora,
      paquete: z.string().describe("Nombre exacto del paquete o servicio, tal como aparece en la información del negocio"),
      extras: z.array(z.string()).describe("Nombres exactos de los extras que agregó el cliente; vacío si no quiere ninguno"),
      barbero: z.string().describe('Nombre del barbero elegido, o "cualquiera"'),
      nombre,
    }),
    ejecutar: async ({ fecha, hora, paquete, extras, barbero, nombre }, ctx) => {
      try {
        const cat = await barberia.catalogo();
        const idsExtras: number[] = [];
        for (const pedido of extras) {
          const extra = cat.extras.find((x) => x.nombre.toLowerCase() === pedido.toLowerCase());
          if (!extra) return `No existe el extra "${pedido}". Los extras son: ${cat.extras.map((x) => x.nombre).join(", ")}.`;
          idsExtras.push(extra.id);
        }
        const exacto = cat.paquetes.find((p) => p.nombre.toLowerCase() === paquete.toLowerCase())?.nombre ?? paquete;

        const r = await barberia.reservar({
          cliente: nombre,
          telefono: ctx.telefono,
          servicio: exacto,
          extras: idsExtras,
          fecha,
          hora,
          barbero: barbero.toLowerCase() === "cualquiera" ? "cualquiera" : barbero,
        });
        const servicio = [exacto, ...extras].join(" + ");
        return registrarReserva(ctx, {
          nombre,
          servicio,
          inicio: `${fecha}T${hora}`,
          fin: await barberia.finDeCita(fecha, hora),
          precio: r.precio,
          barbero: r.barbero,
          codigo: r.codigo,
        });
      } catch (e) {
        return respuestaDeError(e);
      }
    },
  }),
];

const comunes = [
  definir({
    nombre: "ver_mis_citas",
    descripcion: "Lista las próximas citas confirmadas del cliente que está escribiendo.",
    esquema: z.strictObject({}),
    ejecutar: async (_input, ctx) => {
      let turnos = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(new Date()));
      // Las citas de la agenda web pudieron cancelarse desde la página o el panel: se revisa su estado allá.
      const codigos = turnos.flatMap((t) => (t.codigo ? [t.codigo] : []));
      if (codigos.length) {
        try {
          const vivas = new Set((await barberia.citas(codigos)).filter((c) => c.estado !== "cancelada").map((c) => c.codigo));
          for (const t of turnos) if (t.codigo && !vivas.has(t.codigo)) memoria.cancelarTurno(t.id, ctx.telefono);
          turnos = turnos.filter((t) => !t.codigo || vivas.has(t.codigo));
        } catch (e) {
          console.error("No se pudo revisar el estado de las citas en la agenda:", e);
        }
      }
      return turnos.length
        ? turnos.map((t) => `#${t.id}: ${t.servicio}${t.barbero ? ` con ${t.barbero}` : ""}, ${cuando(t.inicio)}`).join("\n")
        : "El cliente no tiene citas próximas agendadas por WhatsApp.";
    },
  }),

  definir({
    nombre: "cancelar_cita",
    descripcion: "Cancela una cita del cliente. Confirma con el cliente antes de cancelar.",
    esquema: z.strictObject({ cita_id: z.number().int().describe("Número de la cita, obtenido de ver_mis_citas") }),
    ejecutar: async ({ cita_id }, ctx) => {
      const ahora = new Date();
      const proxima = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(ahora)).find((t) => t.id === cita_id);
      if (!proxima) return "No encontré esa cita entre las próximas citas de este cliente.";

      const plazo = fueraDePlazo(proxima.inicio);
      if (plazo) return plazo;

      try {
        const turno = await cancelar(cita_id, ctx.telefono);
        if (!turno) return "No encontré esa cita entre las citas de este cliente.";
        await avisarAlDueno(`❌ Cita #${turno.id} cancelada: ${turno.nombre} — ${turno.servicio}, ${cuando(turno.inicio)}`);
        return `Cita #${turno.id} cancelada.`;
      } catch (e) {
        return respuestaDeError(e);
      }
    },
  }),

  definir({
    nombre: "confirmar_cita",
    descripcion:
      "Marca que el cliente confirmó que sí va a ir a su cita (por ejemplo, cuando contesta el recordatorio con \"confirmo\" o \"ahí estaré\").",
    esquema: z.strictObject({ cita_id: z.number().int().describe("Número de la cita, obtenido de ver_mis_citas") }),
    ejecutar: (({ cita_id }, ctx) => {
      const cita = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(new Date())).find((t) => t.id === cita_id);
      if (!cita) return "No encontré esa cita entre las próximas citas de este cliente.";
      if (!cita.confirmada) {
        memoria.actualizarTurno(cita_id, "confirmada", 1);
        memoria.registrarEvento("confirmacion", ctx.telefono, String(cita_id));
      }
      return `Cita #${cita_id} confirmada: ${cita.servicio}${cita.barbero ? ` con ${cita.barbero}` : ""}, ${cuando(cita.inicio)}.`;
    }),
  }),

  definir({
    nombre: "reprogramar_cita",
    descripcion:
      "Cambia la fecha y hora de una cita del cliente (mismo paquete y mismo barbero). Antes consulta la disponibilidad " +
      "con ese barbero y confirma el nuevo horario con el cliente.",
    esquema: z.strictObject({
      cita_id: z.number().int().describe("Número de la cita, obtenido de ver_mis_citas"),
      fecha,
      hora,
    }),
    ejecutar: async ({ cita_id, fecha, hora }, ctx) => {
      const cita = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(new Date())).find((t) => t.id === cita_id);
      if (!cita) return "No encontré esa cita entre las próximas citas de este cliente.";
      const plazo = fueraDePlazo(cita.inicio);
      if (plazo) return plazo;

      const inicio = `${fecha}T${hora}`;
      let fin: string;
      try {
        if (cita.codigo) {
          await barberia.reprogramar(cita.codigo, fecha, hora);
          fin = await barberia.finDeCita(fecha, hora);
        } else {
          if (!horariosLibresLocal(fecha, cita.servicio, cita.id).includes(hora)) {
            return `El horario ${hora} del ${fecha} no está disponible. Vuelve a consultar la disponibilidad.`;
          }
          fin = `${fecha}T${aHora(aMinutos(hora) + (agenda.servicios[cita.servicio] ?? aMinutos(cita.fin.slice(11)) - aMinutos(cita.inicio.slice(11))))}`;
        }
      } catch (e) {
        return respuestaDeError(e);
      }

      const datos = memoria.turnoPorId(cita.id)!;
      memoria.moverTurno(cita.id, inicio, fin, inicio <= fechaHoraLocal(new Date(Date.now() + 26 * 3600_000)));
      memoria.registrarEvento("reprogramacion", ctx.telefono, String(cita.id));
      await quitarDelCalendario(datos.evento_calendario);
      const evento = await agregarAlCalendario({ ...cita, inicio, fin, telefono: ctx.telefono });
      if (evento) memoria.actualizarTurno(cita.id, "evento_calendario", evento);

      await avisarAlDueno(`🔁 Cita #${cita.id} cambiada: ${cita.nombre} — ${cita.servicio}, antes ${cuando(cita.inicio)}, ahora ${cuando(inicio)}`);
      await ofrecerLugarLiberado(cita.inicio.slice(0, 10));
      return `Cita #${cita.id} cambiada: ${cita.servicio}${cita.barbero ? ` con ${cita.barbero}` : ""}, ahora ${cuando(inicio)}.`;
    },
  }),

  definir({
    nombre: "apuntar_lista_espera",
    descripcion:
      "Apunta al cliente en la lista de espera de un día que está lleno. Si alguien cancela o cambia su cita ese día, " +
      "se le avisa automáticamente por aquí. Ofrécela cuando no haya lugar el día que el cliente quiere.",
    esquema: z.strictObject({
      fecha,
      barbero: z.string().describe('Barbero que quiere el cliente, o "cualquiera"'),
    }),
    ejecutar: ({ fecha, barbero }, ctx) => {
      if (fecha < fechaLocal(new Date())) return "Esa fecha ya pasó.";
      const pedido = barbero.toLowerCase() === "cualquiera" ? null : barbero;
      memoria.apuntarEnEspera(ctx.telefono, ctx.nombreWhatsapp, fecha, pedido);
      memoria.registrarEvento("lista_espera", ctx.telefono, fecha);
      return `Cliente apuntado en la lista de espera del ${diaDeLaSemana(fecha)} ${fecha}${pedido ? ` con ${pedido}` : ""}. Si se libera un lugar, se le avisa por aquí.`;
    },
  }),

  definir({
    nombre: "tomar_pedido",
    descripcion:
      "Registra un pedido de productos del negocio y avisa al dueño. Úsala cuando el cliente confirmó qué quiere y su nombre.",
    esquema: z.strictObject({
      nombre,
      detalle: z.string().describe("Productos, cantidades y cualquier aclaración (cuándo pasa a recogerlo, etc.)"),
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
      "Pasa la conversación a una persona del negocio. Úsala si el cliente lo pide, está molesto, o pregunta algo que no está en la información del negocio.",
    esquema: z.strictObject({ motivo: z.string().describe("Resumen breve de qué necesita el cliente") }),
    ejecutar: async ({ motivo }, ctx) => {
      memoria.cambiarModo(ctx.telefono, "humano");
      memoria.registrarEvento("derivacion", ctx.telefono, motivo);
      await avisarAlDueno(
        `🙋 ${ctx.nombreWhatsapp ?? "Un cliente"} (+${ctx.telefono}) necesita atención: ${motivo}\n\n` +
          `Respóndele con: /responder ${ctx.telefono} <mensaje>\nCuando termines: /reactivar ${ctx.telefono}`,
      );
      return "Conversación pasada a una persona. Avísale al cliente que en breve le responde alguien del negocio.";
    },
  }),

  definir({
    nombre: "dejar_de_enviar_mensajes",
    descripcion:
      "El cliente pide que ya no le manden mensajes automáticos (recordatorios, seguimientos, avisos de lugares libres). " +
      "Úsala apenas lo pida, sin insistir ni preguntar por qué.",
    esquema: z.strictObject({}),
    ejecutar: async (_, ctx) => {
      memoria.cambiarBaja(ctx.telefono, true);
      await avisarAlDueno(`🔕 ${ctx.nombreWhatsapp ?? "Un cliente"} (+${ctx.telefono}) pidió no recibir mensajes automáticos.`);
      return "Listo: ya no recibirá mensajes automáticos. Confírmaselo y dile que si cambia de opinión escriba ALTA; si escribe, se le sigue atendiendo.";
    },
  }),
];

const herramientas = [...(barberia.barberiaActiva() ? citasBarberia : citasLocales), ...comunes];

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
