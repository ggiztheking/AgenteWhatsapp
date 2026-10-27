// WhatsApp por Sent: envíos (texto, plantillas con variables por nombre), la ventana de 24 h, avisos al dueño,
// la firma de los avisos de Sent y la lectura del mensaje recibido. Contra un servidor local que imita a Sent.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, mock, test } from "node:test";

type Pedido = { metodo: string; ruta: string; clave: string; cuerpo: Record<string, unknown> | null };
const pedidos: Pedido[] = [];
const servidor = createServer((req, res) => {
  let cuerpo = "";
  req.on("data", (c) => (cuerpo += c));
  req.on("end", () => {
    pedidos.push({ metodo: req.method!, ruta: req.url!, clave: String(req.headers["x-api-key"]), cuerpo: cuerpo ? JSON.parse(cuerpo) : null });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url?.startsWith("/v3/templates/")) {
      res.end(JSON.stringify({ success: true, data: { id: "plantilla-1", variables: ["nombre", "servicio", "cuando"] } }));
      return;
    }
    res.statusCode = 202;
    res.end(JSON.stringify({ success: true, data: { status: "QUEUED", recipients: [{ message_id: "m1" }] } }));
  });
});
await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
after(() => servidor.close());
mock.method(console, "log", () => {});
mock.method(console, "error", () => {});

const SECRETO = "whsec_" + Buffer.from("secreto-de-prueba-123").toString("base64");
Object.assign(process.env, {
  DB_PATH: ":memory:",
  WHATSAPP_TOKEN: "",
  WHATSAPP_PROVEEDOR: "",
  SENT_API_KEY: "clave-prueba",
  SENT_WEBHOOK_SECRET: SECRETO,
  SENT_API_URL: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/v3/`,
  DUENO_TELEFONO: "529990000001",
  WHATSAPP_PLANTILLA_AVISO: "plantilla-aviso",
  BARBERIA_URL: "",
  MERCADOPAGO_ACCESS_TOKEN: "",
  GOOGLE_CALENDAR_ID: "",
});

const { config } = await import("../src/config.js");
const whatsapp = await import("../src/whatsapp.js");
const sent = await import("../src/sent.js");
const memoria = await import("../src/memoria.js");

test("con SENT_API_KEY y sin token de Meta, el WhatsApp va por Sent", () => {
  assert.equal(config.whatsappProveedor, "sent");
  assert.ok(whatsapp.whatsappActivo());
});

test("texto libre: fuera de las 24 h no se intenta; dentro, va a Sent en E.164 por WhatsApp", async () => {
  pedidos.length = 0;
  const fuera = await whatsapp.enviarTexto("5219991112222", "hola");
  assert.deepEqual(fuera, { ok: false, codigo: 131047 });
  assert.equal(pedidos.length, 0, "no se manda nada que WhatsApp va a rechazar");

  memoria.marcarEntrada(whatsapp.numeroParaEnviar("5219991112222"));
  assert.deepEqual(await whatsapp.enviarTexto("5219991112222", "¡Hola! ¿En qué te ayudo?"), { ok: true });
  const [p] = pedidos;
  assert.equal(p.metodo, "POST");
  assert.equal(p.ruta, "/v3/messages");
  assert.equal(p.clave, "clave-prueba");
  assert.deepEqual(p.cuerpo, { to: ["+529991112222"], channel: ["whatsapp"], text: "¡Hola! ¿En qué te ayudo?" });

  memoria.marcarEntrada("529991113333", Date.now() - 25 * 3600_000);
  assert.equal((await whatsapp.enviarTexto("529991113333", "x")).ok, false, "pasadas 24 h la ventana se cierra");
});

test("plantillas: los parámetros van a las variables de la plantilla, en orden y sin saltos de línea", async () => {
  pedidos.length = 0;
  assert.deepEqual(await whatsapp.enviarPlantilla("529991114444", "plantilla-1", ["Ana", "Corte y\nbarba", "lunes 10:30"]), { ok: true });
  await whatsapp.enviarPlantilla("529991115555", "plantilla-1", ["Beto", "Corte", "martes 11:00"]);
  const consultas = pedidos.filter((p) => p.metodo === "GET");
  assert.equal(consultas.length, 1, "las variables de la plantilla se consultan una sola vez");
  assert.equal(consultas[0].ruta, "/v3/templates/plantilla-1");
  const envio = pedidos.find((p) => p.metodo === "POST")!;
  assert.deepEqual(envio.cuerpo, {
    to: ["+529991114444"],
    channel: ["whatsapp"],
    template: { id: "plantilla-1", parameters: { nombre: "Ana", servicio: "Corte y barba", cuando: "lunes 10:30" } },
  });
  pedidos.length = 0;
  await whatsapp.enviarPlantilla("529991114444", "plantilla-sin-variables");
  assert.deepEqual(pedidos[0].cuerpo, { to: ["+529991114444"], channel: ["whatsapp"], template: { id: "plantilla-sin-variables" } });
});

test("aviso al dueño fuera de su ventana: se guarda y se le manda la plantilla de aviso; al escribir, le llega", async () => {
  pedidos.length = 0;
  await whatsapp.avisarAlDueno("📅 Nueva cita de Ana");
  assert.ok(memoria.hayAvisosPendientes());
  assert.deepEqual(pedidos.map((p) => (p.cuerpo as { template?: { id: string } }).template?.id), ["plantilla-aviso"]);

  pedidos.length = 0;
  memoria.marcarEntrada("529990000001");
  await whatsapp.entregarAvisosPendientes();
  assert.deepEqual(pedidos.map((p) => p.cuerpo?.text), ["📅 Nueva cita de Ana"]);
});

const firmar = (cuerpo: string, { secreto = SECRETO, marca = Math.floor(Date.now() / 1000), id = "wh_1" } = {}) => {
  const llave = Buffer.from(secreto.replace(/^whsec_/, ""), "base64");
  const firma = "v1," + createHmac("sha256", llave).update(`${id}.${marca}.${cuerpo}`).digest("base64");
  const h: Record<string, string> = { "x-webhook-id": id, "x-webhook-timestamp": String(marca), "x-webhook-signature": firma };
  return (n: string) => h[n];
};

test("solo se aceptan avisos firmados por Sent, recientes y sin cambios", () => {
  const cuerpo = JSON.stringify({ event: "message.received", payload: { message_id: "a1" } });
  const raw = Buffer.from(cuerpo);
  assert.ok(sent.firmaValida(raw, firmar(cuerpo)));
  assert.ok(!sent.firmaValida(Buffer.from(cuerpo.replace("a1", "a2")), firmar(cuerpo)), "cuerpo cambiado");
  assert.ok(!sent.firmaValida(raw, firmar(cuerpo, { secreto: "whsec_" + Buffer.from("otro").toString("base64") })), "otro secreto");
  assert.ok(!sent.firmaValida(raw, firmar(cuerpo, { marca: Math.floor(Date.now() / 1000) - 600 })), "de hace 10 minutos");
  assert.ok(!sent.firmaValida(raw, firmar(cuerpo), ""), "sin secreto configurado no se acepta nada");
  assert.ok(!sent.firmaValida(raw, () => undefined), "sin cabeceras");
});

test("lee el mensaje recibido de WhatsApp, con sus fotos y audios; ignora otros eventos y canales", () => {
  const m = sent.mensajeRecibido({
    field: "message",
    event: "message.received",
    payload: {
      message_id: "in-1",
      inbound_number: "+52 999 111 2222",
      text: "quiero este corte",
      channel: "whatsapp",
      media: [{ url: "https://medios.ejemplo/f.jpg", mime_type: "image/jpeg; q=1" }, { nada: 1 }],
    },
  });
  assert.deepEqual(m, { id: "in-1", from: "529991112222", texto: "quiero este corte", medios: [{ url: "https://medios.ejemplo/f.jpg", tipo: "image/jpeg" }] });
  assert.equal(sent.mensajeRecibido({ event: "message.delivered", payload: { message_id: "x", inbound_number: "+1" } }), null);
  assert.equal(sent.mensajeRecibido({ event: "message.received", payload: { message_id: "x", inbound_number: "+1", channel: "sms" } }), null);
  assert.equal(sent.mensajeRecibido({ event: "message.received", payload: { inbound_number: "+1" } }), null);
  assert.equal(sent.mensajeRecibido(null), null);
});
