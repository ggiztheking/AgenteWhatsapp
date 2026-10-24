import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import * as memoria from "./memoria.js";

const API = "https://graph.facebook.com/v23.0";
// Error de Meta cuando pasaron más de 24 h desde el último mensaje de esa persona.
const FUERA_DE_VENTANA = 131047;

type Resultado = { ok: true } | { ok: false; codigo?: number };

async function enviar(para: string, cuerpo: Record<string, unknown>): Promise<Resultado> {
  const res = await fetch(`${API}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to: para, ...cuerpo }),
  });
  if (res.ok) return { ok: true };
  const detalle = await res.text();
  console.error(`Error enviando WhatsApp a ${para}: ${res.status} ${detalle}`);
  try {
    return { ok: false, codigo: JSON.parse(detalle).error?.code };
  } catch {
    return { ok: false };
  }
}

/** Envía un mensaje de texto. Sin WHATSAPP_TOKEN (modo consola) solo lo muestra en pantalla. */
export async function enviarTexto(para: string, texto: string): Promise<Resultado> {
  if (!config.whatsapp.token) {
    console.log(`\n[WhatsApp → ${para}]\n${texto}\n`);
    return { ok: true };
  }
  return enviar(para, { type: "text", text: { body: texto.slice(0, 4096) } });
}

/** Envía una plantilla aprobada; los parámetros reemplazan {{1}}, {{2}}, ... del cuerpo. */
export async function enviarPlantilla(para: string, nombre: string, parametros: string[] = []): Promise<Resultado> {
  if (!config.whatsapp.token) {
    console.log(`\n[Plantilla ${nombre} → ${para}] ${parametros.join(" | ")}\n`);
    return { ok: true };
  }
  return enviar(para, {
    type: "template",
    template: {
      name: nombre,
      language: { code: config.whatsapp.idiomaPlantillas },
      // Meta no acepta saltos de línea ni tabulaciones en los parámetros.
      components: parametros.length
        ? [{ type: "body", parameters: parametros.map((p) => ({ type: "text", text: p.replace(/\s+/g, " ") })) }]
        : [],
    },
  });
}

/** Marca el mensaje como leído (tildes azules) y muestra "escribiendo..." mientras el agente piensa. */
export async function marcarLeido(idMensaje: string): Promise<void> {
  if (!config.whatsapp.token) return;
  const res = await fetch(`${API}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: idMensaje,
      typing_indicator: { type: "text" },
    }),
  });
  if (!res.ok) console.error(`Error marcando como leído ${idMensaje}: ${res.status} ${await res.text()}`);
}

/** Descarga un archivo (imagen, audio) que mandó un cliente. */
export async function descargarMedia(idMedia: string): Promise<{ datos: Buffer; tipo: string }> {
  const auth = { Authorization: `Bearer ${config.whatsapp.token}` };
  const info = await fetch(`${API}/${idMedia}`, { headers: auth });
  if (!info.ok) throw new Error(`No se pudo obtener el archivo ${idMedia}: ${info.status}`);
  const { url, mime_type } = (await info.json()) as { url: string; mime_type: string };
  const archivo = await fetch(url, { headers: auth });
  if (!archivo.ok) throw new Error(`No se pudo descargar el archivo ${idMedia}: ${archivo.status}`);
  return { datos: Buffer.from(await archivo.arrayBuffer()), tipo: mime_type.split(";")[0].trim() };
}

/**
 * Avisa al dueño. Si pasaron más de 24 h desde su último mensaje, WhatsApp no deja mandar texto libre:
 * el aviso queda guardado, se le manda la plantilla de aviso, y cuando el dueño responde le llega todo.
 */
export async function avisarAlDueno(texto: string): Promise<void> {
  if (!config.duenoTelefono) {
    console.log(`[Aviso al dueño] ${texto}`);
    return;
  }
  const r = await enviarTexto(config.duenoTelefono, texto);
  if (r.ok || r.codigo !== FUERA_DE_VENTANA) return;

  const yaHabiaPendientes = memoria.hayAvisosPendientes();
  memoria.guardarAvisoPendiente(texto);
  if (!yaHabiaPendientes && config.whatsapp.plantillaAviso) {
    await enviarPlantilla(config.duenoTelefono, config.whatsapp.plantillaAviso);
  }
}

/** Entrega los avisos que quedaron guardados; se llama cuando el dueño escribe. */
export async function entregarAvisosPendientes(): Promise<void> {
  const avisos = memoria.tomarAvisosPendientes();
  for (const aviso of avisos) await enviarTexto(config.duenoTelefono, aviso);
}

/** Verifica la cabecera X-Hub-Signature-256 que firma Meta con el App Secret. */
export function firmaValida(cuerpoCrudo: Buffer, firma: string | undefined): boolean {
  if (!config.whatsapp.appSecret) return true;
  if (!firma?.startsWith("sha256=")) return false;
  const esperada = createHmac("sha256", config.whatsapp.appSecret).update(cuerpoCrudo).digest("hex");
  const a = Buffer.from(firma.slice("sha256=".length), "hex");
  const b = Buffer.from(esperada, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
