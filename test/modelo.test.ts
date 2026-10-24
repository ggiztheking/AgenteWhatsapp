// CLAUDE_MODELO elige el modelo; Haiku no lleva el fallback del servidor (no lo soporta).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

const pedidos: Record<string, unknown>[] = [];
const servidor = createServer((req, res) => {
  let cuerpo = "";
  req.on("data", (c) => (cuerpo += c));
  req.on("end", () => {
    pedidos.push({ ...JSON.parse(cuerpo), beta: req.headers["anthropic-beta"] ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_sequence: null,
        stop_reason: "end_turn",
        content: [{ type: "text", text: "¡Hola! ¿En qué te ayudo?" }],
      }),
    );
  });
});
await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
after(() => servidor.close());

Object.assign(process.env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`,
  ANTHROPIC_API_KEY: "sk-ant-prueba",
  CLAUDE_MODELO: "claude-haiku-5-5",
  DB_PATH: ":memory:",
  WHATSAPP_TOKEN: "",
  DUENO_TELEFONO: "",
  BARBERIA_URL: "",
});

const { responder } = await import("../src/agente.js");

test("usa el modelo de CLAUDE_MODELO y no manda fallbacks a Haiku", async () => {
  assert.match(await responder("5219990000001", "Ana", "hola"), /Hola/);
  const [pedido] = pedidos;
  assert.equal(pedido.model, "claude-haiku-5-5");
  assert.equal(pedido.fallbacks, undefined);
  assert.doesNotMatch(String(pedido.beta), /server-side-fallback/);
});
