// WhatsApp sin servicios externos: el servidor se vincula al número de la barbería escaneando un QR (como WhatsApp
// Web), con la librería abierta Baileys. Sin claves, sin plantillas y sin ventana de 24 h.
// Es un método no oficial: WhatsApp puede bloquear el número si detecta automatización. Por eso el agente responde
// con "escribiendo…" y una pausa, y los mensajes automáticos (recordatorios, lista de espera) tienen un tope por hora
// y solo van a quien ya escribió antes.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { config } from "./config.js";

export type Estado = "apagado" | "esperando QR" | "conectado";
export type MensajeWeb = {
  id: string;
  from: string; // solo dígitos (52… o 521…)
  nombre: string | null;
  type: "text" | "image" | "audio" | "button";
  texto: string;
  original: WAMessage; // para bajar la foto o el audio
};

let sock: WASocket | undefined;
let estado: Estado = "apagado";
let qrActual = "";
let alRecibir: (m: MensajeWeb) => void = () => {};
const jidDe = new Map<string, string>(); // teléfono → jid con el que escribió (puede ser un @lid)
const claves = new Map<string, WAMessage["key"]>(); // id → key, para marcarlo leído
const automaticos: number[] = [];

export const estadoActual = () => estado;
export const conectado = () => estado === "conectado";

const digitos = (jid: string) => jid.split("@")[0].split(":")[0].replace(/\D/g, "");

/** Traduce un mensaje de Baileys; null si no es para el agente (grupos, difusiones, propios, sin contenido). */
export function traducir(msg: WAMessage): MensajeWeb | null {
  const k = msg.key;
  const jid = k?.remoteJid ?? "";
  if (!k?.id || !jid || k.fromMe || isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return null;
  // Con los ids nuevos de WhatsApp (@lid) el número real viene aparte.
  const pn = [jid, k.remoteJidAlt ?? ""].find((j) => j.endsWith("@s.whatsapp.net")) ?? jid;
  const from = digitos(pn);
  const contenido = normalizeMessageContent(msg.message);
  const tipo = contenido && getContentType(contenido);
  if (!from || !contenido || !tipo) return null;
  const base = { id: k.id, from, nombre: msg.pushName ?? null, original: msg };
  switch (tipo) {
    case "conversation":
      return { ...base, type: "text", texto: contenido.conversation ?? "" };
    case "extendedTextMessage":
      return { ...base, type: "text", texto: contenido.extendedTextMessage?.text ?? "" };
    case "imageMessage":
      return { ...base, type: "image", texto: contenido.imageMessage?.caption ?? "" };
    case "audioMessage":
      return { ...base, type: "audio", texto: "" };
    case "buttonsResponseMessage":
      return { ...base, type: "button", texto: contenido.buttonsResponseMessage?.selectedDisplayText ?? "" };
    case "templateButtonReplyMessage":
      return { ...base, type: "button", texto: contenido.templateButtonReplyMessage?.selectedDisplayText ?? "" };
    default:
      return { ...base, type: "text", texto: "" }; // stickers, ubicaciones…: el agente pide que lo escriba
  }
}

/** Tope de mensajes automáticos por hora (los que el agente manda sin que le escriban). */
export function permitirAutomatico(ahora = Date.now(), tope = Number(process.env.WHATSAPP_WEB_TOPE_HORA || 30)): boolean {
  while (automaticos.length && ahora - automaticos[0] > 3600_000) automaticos.shift();
  if (automaticos.length >= tope) return false;
  automaticos.push(ahora);
  return true;
}

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const carpetaSesion = () => join(dirname(config.dbPath), "whatsapp-web");

async function jidPara(telefono: string): Promise<string | null> {
  const d = telefono.replace(/\D/g, "");
  const conocido = jidDe.get(d);
  if (conocido) return conocido;
  // Los celulares de México pueden estar registrados como 52… o 521…: WhatsApp dice cuál.
  for (const n of new Set([d, /^521\d{10}$/.test(d) ? `52${d.slice(3)}` : /^52\d{10}$/.test(d) ? `521${d.slice(2)}` : d])) {
    const [r] = (await sock?.onWhatsApp(n)) ?? [];
    if (r?.exists) {
      jidDe.set(d, r.jid);
      return r.jid;
    }
  }
  return null;
}

/** Manda un texto como lo haría una persona: "escribiendo…", una pausa corta y el mensaje. */
export async function enviarTextoWeb(telefono: string, texto: string): Promise<{ ok: boolean }> {
  if (!sock || !conectado()) return { ok: false };
  try {
    const jid = await jidPara(telefono);
    if (!jid) {
      console.error(`+${telefono} no tiene WhatsApp`);
      return { ok: false };
    }
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    await esperar(1000 + Math.min(2000, texto.length * 15));
    await sock.sendMessage(jid, { text: texto.slice(0, 4096) });
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
    return { ok: true };
  } catch (e) {
    console.error(`Error enviando WhatsApp a ${telefono}:`, e);
    return { ok: false };
  }
}

export async function marcarLeidoWeb(id: string): Promise<void> {
  const key = claves.get(id);
  if (sock && key) await sock.readMessages([key]).catch(() => {});
}

export async function descargarWeb(m: WAMessage): Promise<{ datos: Buffer; tipo: string }> {
  const datos = (await downloadMediaMessage(m, "buffer", {})) as Buffer;
  const c = normalizeMessageContent(m.message);
  const tipo = (c?.imageMessage?.mimetype ?? c?.audioMessage?.mimetype ?? "").split(";")[0].trim();
  return { datos, tipo };
}

/** Se conecta (o muestra el QR para vincular) y se reconecta solo. */
export async function iniciar(recibir: (m: MensajeWeb) => void): Promise<void> {
  alRecibir = recibir;
  const { state, saveCreds } = await useMultiFileAuthState(carpetaSesion());
  sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }), markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrActual = qr;
      estado = "esperando QR";
      console.log("📱 WhatsApp: escanea el QR en /vincular para vincular el número de la barbería.");
    }
    if (connection === "open") {
      estado = "conectado";
      qrActual = "";
      console.log(`📱 WhatsApp vinculado: +${digitos(sock?.user?.id ?? "")}`);
    }
    if (connection === "close") {
      const codigo = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      estado = "apagado";
      if (codigo === DisconnectReason.loggedOut) {
        // Desvincularon el servidor desde el celular: se borra la sesión y se pide un QR nuevo.
        console.warn("⚠️  WhatsApp cerró la sesión del servidor: vuelve a escanear el QR en /vincular.");
        rmSync(carpetaSesion(), { recursive: true, force: true });
      }
      setTimeout(() => iniciar(alRecibir).catch((e) => console.error("Error reconectando WhatsApp:", e)), 3000);
    }
  });
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      const m = traducir(msg);
      if (!m) continue;
      jidDe.set(m.from, msg.key.remoteJid!);
      claves.set(m.id, msg.key);
      if (claves.size > 500) claves.delete(claves.keys().next().value!);
      alRecibir(m);
    }
  });
}

const escapar = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Página para vincular el número: pide la clave (WHATSAPP_VERIFY_TOKEN) y se refresca sola. */
export async function paginaVincular(clave: unknown): Promise<{ status: number; html: string }> {
  if (!config.whatsapp.verifyToken || clave !== config.whatsapp.verifyToken) return { status: 403, html: "Falta la clave correcta." };
  const qr = qrActual ? await QRCode.toString(qrActual, { type: "svg", margin: 2, width: 320 }) : "";
  const cuerpo =
    estado === "conectado"
      ? `<p>✅ Vinculado al número <b>+${escapar(digitos(sock?.user?.id ?? ""))}</b>. El agente ya contesta.</p>`
      : qr
        ? `<p>En el celular de la barbería: WhatsApp → <b>Dispositivos vinculados</b> → <b>Vincular un dispositivo</b> y escanea:</p>${qr}`
        : "<p>Conectando… (esta página se actualiza sola)</p>";
  return {
    status: 200,
    html: `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><meta name="robots" content="noindex"><title>Vincular WhatsApp</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;text-align:center;color:#181a19;background:#f1efe9}svg{max-width:100%;height:auto;background:#fff}</style>
</head><body><h1>WhatsApp del agente</h1>${cuerpo}</body></html>`,
  };
}
