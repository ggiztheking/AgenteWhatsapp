// Pruebas sin red: base en memoria y sin token de WhatsApp (los envíos solo se muestran en pantalla).
// Uso: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(process.env, {
  DB_PATH: ":memory:",
  WHATSAPP_TOKEN: "",
  DUENO_TELEFONO: "",
  WHATSAPP_PLANTILLA_RECORDATORIO: "recordatorio_turno",
  MERCADOPAGO_ACCESS_TOKEN: "",
  GOOGLE_CALENDAR_ID: "",
  OPENAI_API_KEY: "",
  RESUMEN_DIARIO_HORA: "",
});

const { ejecutarHerramienta } = await import("../src/herramientas.js");
const { resumen, agendaDelDia } = await import("../src/insights.js");
const { diaDeLaSemana, fechaHoraLocal, fechaLocal, sumarDias } = await import("../src/fechas.js");
const { enviarRecordatorios } = await import("../src/tareas.js");
const memoria = await import("../src/memoria.js");

const ctx = { telefono: "5491100000001", nombreWhatsapp: "Ana" };
const otro = { telefono: "5491100000002", nombreWhatsapp: "Beto" };

/** Próximo lunes a partir de la semana que viene (siempre abierto según agenda.json). */
function proximoLunes(): string {
  let f = sumarDias(fechaLocal(new Date()), 7);
  while (diaDeLaSemana(f) !== "lunes") f = sumarDias(f, 1);
  return f;
}

const herramienta = async (nombre: string, input: unknown, c = ctx) => (await ejecutarHerramienta(nombre, input, c)).contenido;

test("ofrece horarios dentro del horario de atención", async () => {
  const r = await herramienta("consultar_disponibilidad", { fecha: proximoLunes(), servicio: "Corte de pelo" });
  assert.match(r, /10:00/);
  assert.match(r, /18:30/);
  assert.doesNotMatch(r, /19:00/);
});

test("no da turnos los domingos ni en días cerrados por el dueño", async () => {
  let domingo = fechaLocal(new Date());
  while (diaDeLaSemana(domingo) !== "domingo") domingo = sumarDias(domingo, 1);
  assert.match(await herramienta("consultar_disponibilidad", { fecha: domingo, servicio: "Color" }), /No hay horarios/);

  const dia = sumarDias(proximoLunes(), 1);
  memoria.cerrarDia(dia, true);
  assert.match(await herramienta("consultar_disponibilidad", { fecha: dia, servicio: "Color" }), /No hay horarios/);
  memoria.cerrarDia(dia, false);
  assert.match(await herramienta("consultar_disponibilidad", { fecha: dia, servicio: "Color" }), /Horarios libres/);
});

test("agenda un turno y no deja superponer otro", async () => {
  const fecha = proximoLunes();
  assert.match(await herramienta("agendar_turno", { fecha, hora: "11:00", servicio: "Color", nombre: "Ana" }), /confirmado/);
  // Color dura 90 min: 11:30 y 12:00 quedan ocupados para otros.
  assert.match(
    await herramienta("agendar_turno", { fecha, hora: "12:00", servicio: "Corte de pelo", nombre: "Beto" }, otro),
    /no está disponible/,
  );
  assert.match(await herramienta("ver_mis_turnos", {}), /Color/);
  assert.match(agendaDelDia(fecha), /11:00 · Color · Ana/);
});

test("un cliente no puede cancelar turnos de otro", async () => {
  const [turno] = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(new Date()));
  assert.match(await herramienta("cancelar_turno", { turno_id: turno.id }, otro), /No encontré/);
});

test("cancela con anticipación, pero no a menos de 2 h del turno", async () => {
  const [turno] = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(new Date()));
  assert.match(await herramienta("cancelar_turno", { turno_id: turno.id }), /cancelado/);

  const pronto = new Date(Date.now() + 60 * 60_000);
  const id = memoria.crearTurno({
    telefono: ctx.telefono,
    nombre: "Ana",
    servicio: "Brushing",
    inicio: fechaHoraLocal(pronto),
    fin: fechaHoraLocal(new Date(pronto.getTime() + 30 * 60_000)),
  });
  assert.match(await herramienta("cancelar_turno", { turno_id: id }), /menos de 2 h/);
});

test("manda recordatorio una sola vez a los turnos de las próximas 24 h", async () => {
  const manana = new Date(Date.now() + 20 * 3600_000);
  const id = memoria.crearTurno({
    telefono: otro.telefono,
    nombre: "Beto",
    servicio: "Corte de pelo",
    inicio: fechaHoraLocal(manana),
    fin: fechaHoraLocal(new Date(manana.getTime() + 30 * 60_000)),
  });
  const ahora = fechaHoraLocal(new Date());
  const en24 = fechaHoraLocal(new Date(Date.now() + 24 * 3600_000));
  assert.ok(memoria.turnosParaRecordar(ahora, en24).some((t) => t.id === id));
  await enviarRecordatorios();
  assert.ok(!memoria.turnosParaRecordar(ahora, en24).some((t) => t.id === id));
});

test("el resumen cuenta la actividad y lo que el agente no pudo resolver", async () => {
  memoria.registrarEvento("mensaje", ctx.telefono);
  memoria.registrarEvento("mensaje", otro.telefono);
  await herramienta("tomar_pedido", { nombre: "Ana", detalle: "1 cera" });
  await herramienta("derivar_a_humano", { motivo: "¿Hacen alisado?" });
  const r = resumen("semana");
  assert.match(r, /Mensajes: 2 de 2 clientes \(2 nuevos\)/);
  assert.match(r, /Turnos agendados por el agente: 1 · cancelados: 1/);
  assert.match(r, /Pedidos: 1/);
  assert.match(r, /¿Hacen alisado\?/);
  assert.equal(memoria.obtenerModo(ctx.telefono), "humano");
});

test("guarda los avisos al dueño que no se pudieron entregar", () => {
  memoria.guardarAvisoPendiente("uno");
  memoria.guardarAvisoPendiente("dos");
  assert.ok(memoria.hayAvisosPendientes());
  assert.deepEqual(memoria.tomarAvisosPendientes(), ["uno", "dos"]);
  assert.ok(!memoria.hayAvisosPendientes());
});

test("las notas de la persona del negocio quedan en el historial", () => {
  memoria.agregarNota(otro.telefono, "[Persona del negocio le respondió al cliente: hola]");
  const { mensajes } = memoria.cargarConversacion(otro.telefono);
  assert.equal(mensajes.at(-1)?.content, "[Persona del negocio le respondió al cliente: hola]");
});
