// Google Calendar, Mercado Pago, audios y avisos al dueño, con las APIs externas simuladas.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, {
  DB_PATH: ":memory:",
  WHATSAPP_TOKEN: "token",
  WHATSAPP_PHONE_NUMBER_ID: "999",
  DUENO_TELEFONO: "5491199999999",
  WHATSAPP_PLANTILLA_AVISO: "aviso_novedades",
  MERCADOPAGO_ACCESS_TOKEN: "mp",
  MERCADOPAGO_SENA_PORCENTAJE: "30",
  URL_PUBLICA: "https://agente.test/",
  GOOGLE_CALENDAR_ID: "cal@test",
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: "agente@test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  }),
  OPENAI_API_KEY: "sk-prueba",
});

const llamadas: { metodo: string; url: string; cuerpo: string }[] = [];
let duenoFueraDeVentana = true;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const cuerpo = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
  llamadas.push({ metodo: init?.method ?? "GET", url, cuerpo });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (url.includes("oauth2.googleapis.com")) return json({ access_token: "g", expires_in: 3600 });
  if (url.includes("/calendars/")) return init?.method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "ev1" });
  if (url.includes("checkout/preferences")) return json({ init_point: "https://mp.test/pagar" });
  if (url.includes("/v1/payments/")) return json({ status: "approved", external_reference: "turno-1" });
  if (url.includes("audio/transcriptions")) return json({ text: "quiero turno" });
  if (url.endsWith("/media1")) return json({ url: "https://cdn.test/f", mime_type: "audio/ogg; codecs=opus" });
  if (url === "https://cdn.test/f") return new Response(new Uint8Array([1, 2, 3]));
  if (url.endsWith("/messages") && cuerpo.includes('"to":"5491199999999"') && cuerpo.includes('"type":"text"') && duenoFueraDeVentana) {
    return json({ error: { code: 131047 } }, 400);
  }
  return json({});
}) as typeof fetch;

const { ejecutarHerramienta } = await import("../src/herramientas.js");
const { transcribir, turnoDePagoAprobado } = await import("../src/integraciones.js");
const { descargarMedia, entregarAvisosPendientes } = await import("../src/whatsapp.js");
const memoria = await import("../src/memoria.js");
const { diaDeLaSemana, fechaLocal, sumarDias } = await import("../src/fechas.js");

let martes = sumarDias(fechaLocal(new Date()), 7);
while (diaDeLaSemana(martes) !== "martes") martes = sumarDias(martes, 1);
const ctx = { telefono: "5491100000001", nombreWhatsapp: "Ana" };
const buscar = (parte: string) => llamadas.filter((l) => l.url.includes(parte));

test("al agendar: evento en Google Calendar y link de seña de Mercado Pago", async () => {
  const r = await ejecutarHerramienta("agendar_turno", { fecha: martes, hora: "10:00", servicio: "Color", nombre: "Ana" }, ctx);
  // Color cuesta $35.000: la seña del 30% es $10.500.
  assert.match(r.contenido, /seña de \$10\.500.*https:\/\/mp\.test\/pagar/);

  const evento = JSON.parse(buscar("/calendars/")[0].cuerpo);
  assert.equal(evento.start.dateTime, `${martes}T10:00:00`);
  assert.equal(evento.end.dateTime, `${martes}T11:30:00`);
  const preferencia = JSON.parse(buscar("checkout/preferences")[0].cuerpo);
  assert.equal(preferencia.external_reference, "turno-1");
  assert.equal(preferencia.notification_url, "https://agente.test/mercadopago");

  const turno = memoria.turnoPorId(1)!;
  assert.equal(turno.evento_calendario, "ev1");
  assert.equal(turno.pago, "pendiente");
  assert.equal(await turnoDePagoAprobado("123"), 1);
});

test("aviso al dueño fuera de las 24 h: se guarda, va la plantilla y se entrega después", async () => {
  assert.ok(memoria.hayAvisosPendientes());
  assert.equal(buscar("/messages").filter((l) => l.cuerpo.includes("aviso_novedades")).length, 1);
  duenoFueraDeVentana = false;
  await entregarAvisosPendientes();
  assert.ok(!memoria.hayAvisosPendientes());
});

test("descarga y transcribe audios", async () => {
  const audio = await descargarMedia("media1");
  assert.equal(audio.tipo, "audio/ogg");
  assert.equal(await transcribir(audio.datos, audio.tipo), "quiero turno");
});

test("al cancelar se borra el evento del calendario", async () => {
  const r = await ejecutarHerramienta("cancelar_turno", { turno_id: 1 }, ctx);
  assert.match(r.contenido, /cancelado/);
  assert.ok(llamadas.some((l) => l.metodo === "DELETE" && l.url.endsWith("/events/ev1")));
});
