// Prueba el agente completo (SDK real de Anthropic) contra un servidor local que imita la API de Claude.
// Verifica qué se le manda a Claude, el bucle de herramientas, las imágenes, los rechazos y los errores.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

type Pedido = { model: string; system: string; tools: { name: string }[]; messages: { role: string; content: unknown }[] };
const pedidos: Pedido[] = [];
let respuestas: (object | number)[] = [];

const servidor = createServer((req, res) => {
  let cuerpo = "";
  req.on("data", (c) => (cuerpo += c));
  req.on("end", () => {
    pedidos.push(JSON.parse(cuerpo));
    const r = respuestas.shift() ?? 500;
    if (typeof r === "number") {
      res.writeHead(r, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "falla simulada" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, stop_sequence: null, ...r }));
  });
});
await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
after(() => servidor.close());

Object.assign(process.env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
  ANTHROPIC_API_KEY: "sk-ant-prueba",
  DB_PATH: ":memory:",
  WHATSAPP_TOKEN: "",
  DUENO_TELEFONO: "",
  BARBERIA_URL: "",
  CLAUDE_MODELO: "",
  MERCADOPAGO_ACCESS_TOKEN: "",
  GOOGLE_CALENDAR_ID: "",
});

const { responder } = await import("../src/agente.js");
const memoria = await import("../src/memoria.js");
const { diaDeLaSemana, fechaLocal, sumarDias } = await import("../src/fechas.js");

let lunes = sumarDias(fechaLocal(new Date()), 7);
while (diaDeLaSemana(lunes) !== "lunes") lunes = sumarDias(lunes, 1);

const texto = (t: string, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text: t }] });
const usar = (id: string, name: string, input: object) => ({
  stop_reason: "tool_use",
  content: [{ type: "text", text: "Dejame ver." }, { type: "tool_use", id, name, input }],
});

test("consulta, agenda con herramientas y responde al cliente", async () => {
  respuestas = [
    usar("t1", "consultar_disponibilidad", { fecha: lunes, servicio: "Corte y barba" }),
    texto("El lunes tengo 9:30, 10:30 y más. ¿Cuál te queda bien?"),
  ];
  const r1 = await responder("5219991234567", "Ana", "hola, ¿tienes cita para corte y barba el lunes?");
  assert.match(r1, /¿Cuál te queda bien\?/);

  const [primero, segundo] = pedidos.splice(0);
  assert.equal(primero.model, "claude-opus-5-5");
  assert.equal((primero as unknown as { fallbacks: string }).fallbacks, "default");
  assert.match(primero.system, /español de México/);
  assert.match(primero.system, /Estilo Internacional/);
  assert.deepEqual(
    primero.tools.map((t) => t.name).sort(),
    [
      "agendar_cita",
      "apuntar_lista_espera",
      "cancelar_cita",
      "confirmar_cita",
      "consultar_disponibilidad",
      "derivar_a_humano",
      "reprogramar_cita",
      "tomar_pedido",
      "ver_mis_citas",
    ],
  );
  assert.match(JSON.stringify(primero.messages[0].content), /nombre en WhatsApp: Ana/);
  // La segunda vuelta lleva el resultado real de la herramienta.
  const resultado = JSON.stringify(segundo.messages.at(-1));
  assert.match(resultado, /tool_result/);
  assert.match(resultado, /Horarios libres.*09:30/);

  respuestas = [
    usar("t2", "agendar_cita", { fecha: lunes, hora: "10:30", servicio: "Corte y barba", nombre: "Ana" }),
    texto("¡Listo Ana! Te espero el lunes a las 10:30 ✂️"),
  ];
  const r2 = await responder("5219991234567", "Ana", "a las 10:30, soy Ana");
  assert.match(r2, /10:30/);
  assert.equal(memoria.turnosDelDia(lunes).length, 1);
  // El historial completo viaja en cada pedido: la segunda charla incluye la primera.
  assert.ok(pedidos[0].messages.length >= 5);
  pedidos.length = 0;
});

test("manda la foto del cliente a Claude como imagen", async () => {
  respuestas = [texto("¡Qué lindo corte! Ese es un bob, ¿te busco turno?")];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const r = await responder("5491100000002", "Beto", "quiero este corte", { datos: png, tipo: "image/png" });
  assert.match(r, /bob/);
  const contenido = pedidos.splice(0)[0].messages.at(-1)!.content as { type: string; source?: { media_type: string } }[];
  assert.equal(contenido[0].type, "image");
  assert.equal(contenido[0].source?.media_type, "image/png");
  assert.equal(contenido[1].type, "text");
});

test("si Claude rechaza, contesta algo amable", async () => {
  respuestas = [{ stop_reason: "refusal", content: [] }];
  assert.match(await responder("5491100000003", null, "algo raro"), /no te puedo ayudar/);
  pedidos.length = 0;
});

test("si la API falla, avisa al cliente y no pierde la charla", async () => {
  respuestas = [500, 500, 500];
  const r = await responder("5491100000004", null, "hola");
  assert.match(r, /problema técnico/);
  assert.equal(memoria.cargarConversacion("5491100000004").mensajes.length, 1);
  pedidos.length = 0;
});

test("derivar a humano deja al cliente en modo humano", async () => {
  respuestas = [usar("t3", "derivar_a_humano", { motivo: "Quiere hablar con Laura" }), texto("Te paso con Laura 🙌")];
  await responder("5491100000005", "Caro", "quiero hablar con Laura");
  assert.equal(memoria.obtenerModo("5491100000005"), "humano");
  pedidos.length = 0;
});
