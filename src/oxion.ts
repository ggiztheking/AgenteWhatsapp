// Oxion AI (o cualquier proveedor compatible con la API de OpenAI, cambiando OXION_URL). El historial del agente
// se guarda en el formato de Claude, así que aquí se traduce de ida (mensajes, imágenes y herramientas) y de
// vuelta (texto y llamadas a herramientas). Así se puede cambiar de proveedor sin perder las conversaciones.
import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

type Mensaje = Anthropic.Beta.BetaMessageParam;
type Bloque = Anthropic.Beta.BetaContentBlockParam;
type ParteOA = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type LlamadaOA = { id: string; type: "function"; function: { name: string; arguments: string } };
type MensajeOA =
  | { role: "system" | "user"; content: string | ParteOA[] }
  | { role: "assistant"; content: string | null; tool_calls?: LlamadaOA[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type Respuesta = { content: Bloque[]; stop_reason: "end_turn" | "tool_use" | "refusal" | "max_tokens" };

export class ErrorOxion extends Error {
  constructor(
    readonly status: number,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

const textoDe = (c: Anthropic.Beta.BetaToolResultBlockParam["content"]) =>
  typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n");

/** El historial en formato Claude → mensajes de chat de OpenAI. */
export function aMensajesOpenAI(system: string, mensajes: Mensaje[]): MensajeOA[] {
  const salida: MensajeOA[] = [{ role: "system", content: system }];
  // Cada llamada a herramienta necesita su respuesta antes del siguiente mensaje; si una quedó sin respuesta
  // (por ejemplo, la API falló a la mitad), se completa para que el proveedor no rechace todo el historial.
  let pendientes: string[] = [];
  const cerrarPendientes = () => {
    for (const id of pendientes) salida.push({ role: "tool", tool_call_id: id, content: "(sin resultado)" });
    pendientes = [];
  };

  for (const m of mensajes) {
    const bloques: Bloque[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    if (m.role === "assistant") {
      cerrarPendientes();
      const texto = bloques.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
      const llamadas: LlamadaOA[] = bloques.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }]
          : [],
      );
      if (!texto && !llamadas.length) continue; // solo razonamiento interno de Claude: no se manda
      salida.push({ role: "assistant", content: texto || null, ...(llamadas.length && { tool_calls: llamadas }) });
      pendientes = llamadas.map((l) => l.id);
      continue;
    }
    for (const b of bloques) {
      if (b.type !== "tool_result") continue;
      salida.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "Error: " : "") + textoDe(b.content) });
      pendientes = pendientes.filter((id) => id !== b.tool_use_id);
    }
    cerrarPendientes();
    const partes: ParteOA[] = bloques.flatMap((b): ParteOA[] => {
      if (b.type === "text") return [{ type: "text", text: b.text }];
      if (b.type === "image" && b.source.type === "base64")
        return [{ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }];
      return [];
    });
    if (partes.length) salida.push({ role: "user", content: partes.length === 1 && partes[0].type === "text" ? partes[0].text : partes });
  }
  cerrarPendientes();
  return salida;
}

// Los ids de herramientas de Claude solo admiten letras, números, _ y -: se limpian por si luego se vuelve a Claude.
const idValido = (id: unknown) =>
  (typeof id === "string" && id ? id : `llamada_${randomBytes(6).toString("hex")}`).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

function leerArgumentos(texto: unknown): unknown {
  if (typeof texto !== "string" || !texto.trim()) return {};
  try {
    return JSON.parse(texto);
  } catch {
    // La validación de la herramienta lo rechaza y el modelo recibe el error para corregirlo.
    return { argumentos_invalidos: texto };
  }
}

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Una vuelta del agente con Oxion: devuelve el mismo contenido que daría Claude (texto y tool_use). */
export async function crearMensaje(system: string, mensajes: Mensaje[], herramientas: Anthropic.Beta.BetaTool[]): Promise<Respuesta> {
  const cuerpo = JSON.stringify({
    model: config.oxion.modelo,
    max_tokens: 4000,
    messages: aMensajesOpenAI(system, mensajes),
    tools: herramientas.map((h) => ({ type: "function", function: { name: h.name, description: h.description, parameters: h.input_schema } })),
  });

  let ultimo: ErrorOxion | undefined;
  for (const espera of [0, 1500, 4000]) {
    if (espera) await esperar(espera);
    let r: Response;
    try {
      r = await fetch(`${config.oxion.url}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.oxion.clave}`, "Content-Type": "application/json" },
        body: cuerpo,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      ultimo = new ErrorOxion(0, `sin conexión: ${(e as Error).message}`);
      continue;
    }
    const d = (await r.json().catch(() => null)) as {
      choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      error?: { message?: string; type?: string };
    } | null;
    const opcion = d?.choices?.[0];
    if (r.ok && opcion?.message) {
      const { content, tool_calls } = opcion.message;
      const texto = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : "";
      const bloques: Bloque[] = texto.trim() ? [{ type: "text", text: texto.trim() }] : [];
      for (const t of tool_calls ?? []) {
        if (!t.function?.name) continue;
        bloques.push({ type: "tool_use", id: idValido(t.id), name: t.function.name, input: leerArgumentos(t.function.arguments) });
      }
      const usaHerramientas = bloques.some((b) => b.type === "tool_use");
      const fin = opcion.finish_reason;
      return {
        content: bloques,
        stop_reason: usaHerramientas ? "tool_use" : fin === "content_filter" ? "refusal" : fin === "length" ? "max_tokens" : "end_turn",
      };
    }
    ultimo = new ErrorOxion(r.status, d?.error?.message ?? `respuesta inesperada (${r.status})`);
    // Se reintenta lo pasajero (saturación, mantenimiento, fallas del servidor); lo demás (clave, saldo) no.
    if (!(r.status === 429 || r.status >= 500 || d?.error?.type === "maintenance")) break;
  }
  throw ultimo!;
}
