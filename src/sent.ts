// WhatsApp por Sent (app.sent.dm) en lugar de la Cloud API de Meta: envío de textos y plantillas, firma de los
// avisos que llegan a /sent y traducción del mensaje recibido al mismo formato que usa el resto del agente.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export type Resultado = { ok: true } | { ok: false; codigo?: number | string };
export type MensajeSent = { id: string; from: string; texto: string; medios: { url: string; tipo: string }[] };

const cabeceras = () => ({ "x-api-key": config.sent.apiKey, "Content-Type": "application/json", Accept: "application/json" });

/** Sent pide los números en E.164 (+52 y 10 dígitos para México). */
export const e164 = (telefono: string) => {
  const d = telefono.replace(/\D/g, "");
  return `+${/^521\d{10}$/.test(d) ? `52${d.slice(3)}` : d}`;
};

async function enviar(para: string, contenido: Record<string, unknown>): Promise<Resultado> {
  let res: Response;
  try {
    res = await fetch(`${config.sent.url}/messages`, {
      method: "POST",
      headers: cabeceras(),
      body: JSON.stringify({ to: [e164(para)], channel: ["whatsapp"], ...contenido }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.error(`Error enviando por Sent a ${para}:`, e);
    return { ok: false };
  }
  // 202: aceptado. La entrega se confirma después (y si falla, Sent lo avisa por el webhook).
  if (res.ok) return { ok: true };
  const detalle = await res.text();
  console.error(`Error enviando por Sent a ${para}: ${res.status} ${detalle}`);
  try {
    return { ok: false, codigo: JSON.parse(detalle).error?.code ?? res.status };
  } catch {
    return { ok: false, codigo: res.status };
  }
}

export const enviarTexto = (para: string, texto: string) => enviar(para, { text: texto.slice(0, 4096) });

// Las variables de cada plantilla tienen nombre en Sent ("var_1", "nombre"...): los parámetros van en ese orden.
const variables = new Map<string, string[]>();
async function variablesDe(id: string): Promise<string[]> {
  if (!variables.has(id)) {
    const res = await fetch(`${config.sent.url}/templates/${encodeURIComponent(id)}`, { headers: cabeceras(), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Sent no encontró la plantilla ${id}: ${res.status}`);
    const datos = (await res.json()) as { data?: { variables?: string[]; template?: { variables?: string[] } } };
    variables.set(id, datos.data?.variables ?? datos.data?.template?.variables ?? []);
  }
  return variables.get(id)!;
}

export async function enviarPlantilla(para: string, id: string, parametros: string[] = []): Promise<Resultado> {
  let nombres: string[];
  try {
    nombres = parametros.length ? await variablesDe(id) : [];
  } catch (e) {
    console.error(e);
    return { ok: false };
  }
  // Sent no acepta saltos de línea, tabulaciones ni muchos espacios seguidos en las variables.
  const valores = Object.fromEntries(nombres.map((n, i) => [n, (parametros[i] ?? "").replace(/\s+/g, " ").trim()]));
  return enviar(para, { template: { id, ...(nombres.length && { parameters: valores }) } });
}

/** Comprueba la firma de Sent: HMAC-SHA256 de "{id}.{timestamp}.{cuerpo}" con el secreto (whsec_ + base64). */
export function firmaValida(
  cuerpoCrudo: Buffer,
  cabecera: (nombre: string) => string | undefined,
  secreto = config.sent.secretoWebhook,
  ahora = Date.now(),
): boolean {
  if (!secreto) return false; // sin secreto no se acepta nada: cualquiera podría hacer que el agente escriba
  const id = cabecera("x-webhook-id"), marca = cabecera("x-webhook-timestamp"), firma = cabecera("x-webhook-signature");
  if (!id || !marca || !firma?.startsWith("v1,")) return false;
  if (!/^\d+$/.test(marca) || Math.abs(ahora / 1000 - Number(marca)) > 300) return false; // más de 5 minutos: repetido
  const llave = Buffer.from(secreto.replace(/^whsec_/, ""), "base64");
  const esperada = createHmac("sha256", llave).update(`${id}.${marca}.`).update(cuerpoCrudo).digest();
  const recibida = Buffer.from(firma.slice(3), "base64");
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}

/** El mensaje de un aviso "message.received" de WhatsApp; null si es otro evento u otro canal. */
export function mensajeRecibido(cuerpo: unknown): MensajeSent | null {
  const e = cuerpo as { event?: string; payload?: Record<string, unknown> } | null;
  const p = e?.payload;
  if (e?.event !== "message.received" || !p || (p.channel && p.channel !== "whatsapp")) return null;
  const id = typeof p.message_id === "string" ? p.message_id : "";
  const de = typeof p.inbound_number === "string" ? p.inbound_number.replace(/\D/g, "") : "";
  if (!id || !de) return null;
  const medios = (Array.isArray(p.media) ? p.media : [])
    .filter((m): m is { url: string; mime_type?: string } => typeof m?.url === "string")
    .map((m) => ({ url: m.url, tipo: String(m.mime_type ?? "").split(";")[0].trim() }));
  return { id, from: de, texto: typeof p.text === "string" ? p.text : "", medios };
}

/** Descarga un archivo de un mensaje (la dirección que da Sent no pide clave y vence: se baja al recibirlo). */
export async function descargar(url: string, tipo: string): Promise<{ datos: Buffer; tipo: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`No se pudo descargar el archivo: ${res.status}`);
  return { datos: Buffer.from(await res.arrayBuffer()), tipo: tipo || (res.headers.get("content-type") ?? "").split(";")[0].trim() };
}
