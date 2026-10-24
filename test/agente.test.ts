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
  BARBERIA_URL: "",
});

const { ejecutarHerramienta } = await import("../src/herramientas.js");
const { resumen, agendaDelDia } = await import("../src/insights.js");
const { diaDeLaSemana, fechaHoraLocal, fechaLocal, sumarDias } = await import("../src/fechas.js");
const { enviarRecordatorios } = await import("../src/tareas.js");
const memoria = await import("../src/memoria.js");
const { agenda } = await import("../src/config.js");
const { mismoNumero, numeroParaEnviar } = await import("../src/whatsapp.js");
agenda.anticipacionCancelarHoras = 2;

const ctx = { telefono: "5491100000001", nombreWhatsapp: "Ana" };
const otro = { telefono: "5491100000002", nombreWhatsapp: "Beto" };

/** Próximo lunes a partir de la semana que viene. */
function proximoLunes(): string {
  let f = sumarDias(fechaLocal(new Date()), 7);
  while (diaDeLaSemana(f) !== "lunes") f = sumarDias(f, 1);
  return f;
}

const herramienta = async (nombre: string, input: unknown, c = ctx) => (await ejecutarHerramienta(nombre, input, c)).contenido;

test("ofrece horarios dentro del horario de atención (9:30 a 23:00)", async () => {
  const r = await herramienta("consultar_disponibilidad", { fecha: proximoLunes(), servicio: "Elige tu corte" });
  assert.match(r, /09:30/);
  assert.match(r, /21:30/);
  // Una cita de 60 min a las 22:30 terminaría después del cierre.
  assert.doesNotMatch(r, /22:30/);
});

test("no da citas en días cerrados por el dueño", async () => {
  const dia = sumarDias(proximoLunes(), 1);
  memoria.cerrarDia(dia, true);
  assert.match(await herramienta("consultar_disponibilidad", { fecha: dia, servicio: "VIP Diamante" }), /No hay horarios/);
  memoria.cerrarDia(dia, false);
  assert.match(await herramienta("consultar_disponibilidad", { fecha: dia, servicio: "VIP Diamante" }), /Horarios libres/);
});

test("agenda una cita con su precio y no deja empalmar otra", async () => {
  const fecha = proximoLunes();
  assert.match(
    await herramienta("agendar_cita", { fecha, hora: "10:30", servicio: "Corte y barba", nombre: "Ana" }),
    /confirmada.*Total: \$350 MXN/,
  );
  assert.match(
    await herramienta("agendar_cita", { fecha, hora: "10:30", servicio: "Elige tu corte", nombre: "Beto" }, otro),
    /no está disponible/,
  );
  assert.match(await herramienta("ver_mis_citas", {}), /Corte y barba/);
  assert.match(agendaDelDia(fecha), /10:30 · Corte y barba · Ana/);
});

test("un cliente no puede cancelar citas de otro", async () => {
  const [turno] = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(new Date()));
  assert.match(await herramienta("cancelar_cita", { cita_id: turno.id }, otro), /No encontré/);
});

test("cancela con anticipación, pero no a menos de 2 h de la cita", async () => {
  const [turno] = memoria.turnosFuturosDe(ctx.telefono, fechaHoraLocal(new Date()));
  assert.match(await herramienta("cancelar_cita", { cita_id: turno.id }), /cancelada/);

  const pronto = new Date(Date.now() + 60 * 60_000);
  const id = memoria.crearTurno({
    telefono: ctx.telefono,
    nombre: "Ana",
    servicio: "Elige tu corte",
    inicio: fechaHoraLocal(pronto),
    fin: fechaHoraLocal(new Date(pronto.getTime() + 30 * 60_000)),
  });
  assert.match(await herramienta("cancelar_cita", { cita_id: id }), /menos de 2 h/);
});

test("manda recordatorio una sola vez a los turnos de las próximas 24 h", async () => {
  const manana = new Date(Date.now() + 20 * 3600_000);
  const id = memoria.crearTurno({
    telefono: otro.telefono,
    nombre: "Beto",
    servicio: "Elige tu corte",
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
  assert.match(r, /Citas agendadas por el agente: 1 · canceladas: 1/);
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

test("normaliza los celulares de México (521 → 52) para enviar y reconocer al dueño", () => {
  assert.equal(numeroParaEnviar("5219991234567"), "529991234567");
  assert.equal(numeroParaEnviar("+52 999 123 4567"), "529991234567");
  assert.equal(numeroParaEnviar("5491112345678"), "5491112345678");
  assert.ok(mismoNumero("5219991234567", "529991234567"));
  assert.ok(!mismoNumero("5219991234567", ""));
});
