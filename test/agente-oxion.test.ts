// Prueba el agente con Oxion AI contra un servidor local que imita su API (compatible con OpenAI): qué se le
// manda, el bucle de herramientas, las imágenes, los reintentos y que el historial quede en formato de Claude.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, mock, test } from "node:test";

type Pedido = {
  auth: string;
  model: string;
  messages: { role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }[];
  tools: { type: string; function: { name: string; parameters: { type: string } } }[];
};
const pedidos: Pedido[] = [];
let respuestas: (object | number)[] = [];

const servidor = createServer((req, res) => {
  let cuerpo = "";
  req.on("data", (c) => (cuerpo += c));
  req.on("end", () => {
    pedidos.push({ auth: req.headers.authorization ?? "", ...JSON.parse(cuerpo) });
    const r = respuestas.shift() ?? 500;
    res.writeHead(typeof r === "number" ? r : 200, { "content-type": "application/json" });
    if (typeof r === "number") {
      const tipo = r === 503 ? "maintenance" : "authentication_error";
      res.end(JSON.stringify({ error: { message: "falla simulada", type: tipo } }));
    } else res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, ...r }] }));
  });
});
await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
// Sin los registros del agente: mucha salida a la vez a veces rompe el canal del corredor de pruebas de Node
// ("Unable to deserialize cloned data"). Lo que importa se comprueba con assert.
mock.method(console, "log", () => {});
mock.method(console, "error", () => {});
after(() => servidor.close());

Object.assign(process.env, {
  ANTHROPIC_API_KEY: "",
  IA_PROVEEDOR: "",
  OXION_API_KEY: "cc_prueba",
  OXION_URL: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/v1/`,
  OXION_MODELO: "",
  DB_PATH: ":memory:",
  WHATSAPP_TOKEN: "",
  DUENO_TELEFONO: "",
  BARBERIA_URL: "",
  MERCADOPAGO_ACCESS_TOKEN: "",
  GOOGLE_CALENDAR_ID: "",
});

const { responder } = await import("../src/agente.js");
const { aMensajesOpenAI } = await import("../src/oxion.js");
const memoria = await import("../src/memoria.js");
const { diaDeLaSemana, fechaLocal, sumarDias } = await import("../src/fechas.js");

let lunes = sumarDias(fechaLocal(new Date()), 7);
while (diaDeLaSemana(lunes) !== "lunes") lunes = sumarDias(lunes, 1);

const texto = (t: string, fin = "stop") => ({ finish_reason: fin, message: { role: "assistant", content: t } });
const usar = (id: string, name: string, args: object | string) => ({
  finish_reason: "tool_calls",
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }],
  },
});

test("sin clave de Claude usa Oxion: consulta, agenda y responde", async () => {
  respuestas = [usar("call_1", "consultar_disponibilidad", { fecha: lunes, servicio: "Corte y barba" }), texto("El lunes tengo 9:30 y 10:30. ¿Cuál te late?")];
  const r1 = await responder("5219991234567", "Ana", "hola, ¿tienes cita para corte y barba el lunes?");
  assert.match(r1, /¿Cuál te late\?/);

  const [primero, segundo] = pedidos.splice(0);
  assert.equal(primero.auth, "Bearer cc_prueba");
  assert.equal(primero.model, "claude-opus-5.5");
  assert.equal(primero.messages[0].role, "system");
  assert.match(String(primero.messages[0].content), /español de México/);
  assert.match(String(primero.messages[1].content), /nombre en WhatsApp: Ana/);
  assert.ok(primero.tools.some((t) => t.type === "function" && t.function.name === "agendar_cita" && t.function.parameters.type === "object"));
  // La segunda vuelta lleva la llamada y el resultado real de la herramienta.
  const [llamada, resultado] = segundo.messages.slice(-2);
  assert.equal(llamada.role, "assistant");
  assert.equal(llamada.tool_calls?.length, 1);
  assert.equal(resultado.role, "tool");
  assert.equal(resultado.tool_call_id, "call_1");
  assert.match(String(resultado.content), /Horarios libres.*09:30/);

  respuestas = [usar("call_2", "agendar_cita", { fecha: lunes, hora: "10:30", servicio: "Corte y barba", nombre: "Ana" }), texto("¡Listo Ana! Te espero el lunes a las 10:30 ✂️")];
  assert.match(await responder("5219991234567", "Ana", "a las 10:30, soy Ana"), /10:30/);
  assert.equal(memoria.turnosDelDia(lunes).length, 1);
  // El historial queda en el formato de Claude: se puede volver a Claude sin perder la charla.
  const guardado = JSON.stringify(memoria.cargarConversacion("5219991234567").mensajes);
  assert.match(guardado, /"type":"tool_use","id":"call_2","name":"agendar_cita"/);
  assert.match(guardado, /"type":"tool_result","tool_use_id":"call_2"/);
  pedidos.length = 0;
});

test("manda la foto del cliente como imagen", async () => {
  respuestas = [texto("¡Buen corte! Es un fade, ¿te busco lugar?")];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  assert.match(await responder("5219990000002", "Beto", "quiero este corte", { datos: png, tipo: "image/png" }), /fade/);
  const contenido = pedidos.splice(0)[0].messages.at(-1)!.content as { type: string; image_url?: { url: string } }[];
  assert.equal(contenido[0].type, "image_url");
  assert.match(contenido[0].image_url!.url, /^data:image\/png;base64,iVBOR/);
  assert.equal(contenido[1].type, "text");
});

test("si el modelo manda datos rotos a una herramienta, recibe el error y se corrige", async () => {
  respuestas = [usar("call/3", "consultar_disponibilidad", "{fecha: mañana"), texto("¿Qué día te gustaría venir?")];
  assert.match(await responder("5219990000003", null, "quiero cita"), /Qué día/);
  const resultado = pedidos.splice(0)[1].messages.at(-1)!;
  assert.equal(resultado.role, "tool");
  assert.equal(resultado.tool_call_id, "call_3"); // id limpiado para que también lo acepte Claude
  assert.match(String(resultado.content), /^Error: Datos inválidos/);
});

test("reintenta si Oxion está en mantenimiento y avisa al cliente si no se recupera", async () => {
  respuestas = [503, texto("¡Hola! ¿En qué te ayudo?")];
  assert.match(await responder("5219990000004", null, "hola"), /En qué te ayudo/);
  assert.equal(pedidos.splice(0).length, 2);

  respuestas = [503, 503, 503];
  assert.match(await responder("5219990000005", null, "hola"), /problema técnico/);
  assert.equal(pedidos.splice(0).length, 3);
  assert.equal(memoria.cargarConversacion("5219990000005").mensajes.length, 1);
});

test("con una clave inválida no reintenta", async () => {
  respuestas = [401];
  assert.match(await responder("5219990000006", null, "hola"), /problema técnico/);
  assert.equal(pedidos.splice(0).length, 1);
});

test("la traducción completa lo que quedó a medias y omite el razonamiento interno", () => {
  const salida = aMensajesOpenAI("sistema", [
    { role: "user", content: "hola" },
    { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "s" }, { type: "text", text: "Déjame ver" }, { type: "tool_use", id: "t1", name: "ver_mis_citas", input: {} }] },
    { role: "user", content: "¿sigues ahí?" },
    { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "s" }] },
  ]);
  assert.deepEqual(
    salida.map((m) => m.role),
    ["system", "user", "assistant", "tool", "user"],
  );
  assert.equal((salida[3] as { content: string }).content, "(sin resultado)");
});
