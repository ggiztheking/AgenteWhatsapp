// WhatsApp vinculado por QR: qué mensajes le llegan al agente, el tope de automáticos, la página para vincular
// (con clave) y que los recordatorios salgan como texto, solo a quien ya escribió.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

Object.assign(process.env, {
  DB_PATH: ":memory:",
  WHATSAPP_PROVEEDOR: "web",
  WHATSAPP_TOKEN: "",
  SENT_API_KEY: "",
  WHATSAPP_VERIFY_TOKEN: "clave-vincular",
  WHATSAPP_PLANTILLA_RECORDATORIO: "",
  DUENO_TELEFONO: "",
  BARBERIA_URL: "",
  MERCADOPAGO_ACCESS_TOKEN: "",
  GOOGLE_CALENDAR_ID: "",
});
mock.method(console, "log", () => {});
mock.method(console, "error", () => {});

const web = await import("../src/whatsapp-web.js");
const whatsapp = await import("../src/whatsapp.js");
const memoria = await import("../src/memoria.js");
const { enviarRecordatorios } = await import("../src/tareas.js");
const { ejecutarHerramienta } = await import("../src/herramientas.js");
const { aFecha, diaDeLaSemana, fechaHoraLocal, fechaLocal, sumarDias } = await import("../src/fechas.js");

type Msg = Parameters<typeof web.traducir>[0];
const msg = (remoteJid: string, message: Msg["message"], extra: Partial<Msg["key"]> = {}, pushName = "Ana"): Msg =>
  ({ key: { id: "id-" + Math.random(), remoteJid, fromMe: false, ...extra }, message, pushName }) as Msg;

test("traduce texto, fotos, audios y botones; ignora grupos, difusiones y lo que manda el propio número", () => {
  const t = web.traducir(msg("5219991234567@s.whatsapp.net", { conversation: "hola" }))!;
  assert.deepEqual([t.from, t.type, t.texto, t.nombre], ["5219991234567", "text", "hola", "Ana"]);
  assert.equal(web.traducir(msg("5219991234567@s.whatsapp.net", { extendedTextMessage: { text: "con enlace" } }))!.texto, "con enlace");
  const f = web.traducir(msg("5219991234567@s.whatsapp.net", { imageMessage: { caption: "este corte" } }))!;
  assert.deepEqual([f.type, f.texto], ["image", "este corte"]);
  assert.equal(web.traducir(msg("5219991234567@s.whatsapp.net", { audioMessage: {} }))!.type, "audio");
  const b = web.traducir(msg("5219991234567@s.whatsapp.net", { buttonsResponseMessage: { selectedDisplayText: "Confirmo" } }))!;
  assert.deepEqual([b.type, b.texto], ["button", "Confirmo"]);
  // Con los ids nuevos de WhatsApp (@lid), el número sale del jid alterno.
  assert.equal(web.traducir(msg("1234567890@lid", { conversation: "x" }, { remoteJidAlt: "529997654321@s.whatsapp.net" }))!.from, "529997654321");
  // Mensajes temporales: el contenido viene envuelto.
  assert.equal(web.traducir(msg("5219991234567@s.whatsapp.net", { ephemeralMessage: { message: { conversation: "temporal" } } }))!.texto, "temporal");

  assert.equal(web.traducir(msg("120363000000@g.us", { conversation: "grupo" })), null);
  assert.equal(web.traducir(msg("status@broadcast", { conversation: "estado" })), null);
  assert.equal(web.traducir(msg("5219991234567@s.whatsapp.net", { conversation: "yo" }, { fromMe: true })), null);
  assert.equal(web.traducir(msg("5219991234567@s.whatsapp.net", null)), null);
});

test("tope de mensajes automáticos por hora", () => {
  const t0 = 1_000_000_000_000;
  for (let i = 0; i < 3; i++) assert.ok(web.permitirAutomatico(t0 + i, 3));
  assert.ok(!web.permitirAutomatico(t0 + 10, 3), "el cuarto en la misma hora no sale");
  assert.ok(web.permitirAutomatico(t0 + 3600_001, 3), "pasada la hora, vuelve a haber cupo");
});

test("la página para vincular pide la clave y, sin conexión, dice que está conectando", async () => {
  assert.equal((await web.paginaVincular(undefined)).status, 403);
  assert.equal((await web.paginaVincular("otra")).status, 403);
  const ok = await web.paginaVincular("clave-vincular");
  assert.equal(ok.status, 200);
  assert.match(ok.html, /Conectando/);
  assert.match(ok.html, /noindex/);
});

test("sin plantillas: el recordatorio va como texto, solo a quien ya escribió; desconectado no se da por enviado", async () => {
  assert.ok(whatsapp.sinPlantillas());
  assert.equal((await whatsapp.enviarPlantilla("529991112222", "x")).ok, false);
  const eva = { telefono: "5219990000009", nombreWhatsapp: "Eva" };
  let lunes = sumarDias(fechaLocal(new Date()), 7);
  while (diaDeLaSemana(lunes) !== "lunes") lunes = sumarDias(lunes, 1);
  await ejecutarHerramienta("agendar_cita", { fecha: lunes, hora: "11:30", servicio: "Corte y barba", nombre: "Eva" }, eva);
  const [cita] = memoria.turnosFuturosDe(eva.telefono, fechaHoraLocal(new Date()));
  const d = aFecha(cita.inicio);
  await enviarRecordatorios(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 11, 0));
  // Se intentó (queda marcado para no repetir), pero sin el número vinculado no hay nota de "enviado".
  assert.ok(memoria.turnoPorId(cita.id)!.recordado_en, "se intentó aunque no haya plantilla");
  assert.ok(!JSON.stringify(memoria.cargarConversacion(eva.telefono).mensajes).includes("Recordatorio automático"));
  // Quien nunca escribió no recibe automáticos.
  assert.equal(await whatsapp.escribirAlCliente("529990001111", "hola", "", []), false);
});
