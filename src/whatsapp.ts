import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const API = "https://graph.facebook.com/v23.0";

/** Envía un mensaje de texto. Sin WHATSAPP_TOKEN (modo consola) solo lo muestra en pantalla. */
export async function enviarTexto(para: string, texto: string): Promise<void> {
  if (!config.whatsapp.token) {
    console.log(`\n[WhatsApp → ${para}]\n${texto}\n`);
    return;
  }

  const res = await fetch(`${API}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "text",
      text: { body: texto.slice(0, 4096) },
    }),
  });
  if (!res.ok) {
    console.error(`Error enviando WhatsApp a ${para}: ${res.status} ${await res.text()}`);
  }
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

export async function avisarAlDueno(texto: string): Promise<void> {
  if (!config.duenoTelefono) {
    console.log(`[Aviso al dueño] ${texto}`);
    return;
  }
  await enviarTexto(config.duenoTelefono, texto);
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
