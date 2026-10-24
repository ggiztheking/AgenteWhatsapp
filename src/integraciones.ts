// Servicios externos opcionales. Cada uno se activa solo si su variable de entorno está configurada,
// y si falla no frena al agente: se registra el error y el turno o la charla siguen igual.
import { createSign } from "node:crypto";
import { agenda, config } from "./config.js";
import type { Turno } from "./memoria.js";

// --- Google Calendar (cuenta de servicio) ---

export const calendarioActivo = () => !!(config.googleCalendar.calendarId && config.googleCalendar.cuentaServicio);

let tokenGoogle: { valor: string; vence: number } | null = null;

async function tokenDeGoogle(): Promise<string> {
  if (tokenGoogle && tokenGoogle.vence > Date.now() + 60_000) return tokenGoogle.valor;
  const cuenta = JSON.parse(config.googleCalendar.cuentaServicio) as { client_email: string; private_key: string };
  const ahora = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sinFirma = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: cuenta.client_email,
    scope: "https://www.googleapis.com/auth/calendar.events",
    aud: "https://oauth2.googleapis.com/token",
    iat: ahora,
    exp: ahora + 3600,
  })}`;
  const firma = createSign("RSA-SHA256").update(sinFirma).sign(cuenta.private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${sinFirma}.${firma}`,
    }),
  });
  if (!res.ok) throw new Error(`Google no dio el token: ${res.status} ${await res.text()}`);
  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  tokenGoogle = { valor: access_token, vence: Date.now() + expires_in * 1000 };
  return access_token;
}

const urlEventos = () =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events`;

/** Crea el evento del turno y devuelve su id, o null si el calendario no está configurado o falla. */
export async function agregarAlCalendario(t: Turno & { telefono: string }): Promise<string | null> {
  if (!calendarioActivo()) return null;
  try {
    const res = await fetch(urlEventos(), {
      method: "POST",
      headers: { Authorization: `Bearer ${await tokenDeGoogle()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: `${t.servicio} — ${t.nombre}`,
        description: `Turno #${t.id} agendado por WhatsApp. Cliente: +${t.telefono}`,
        start: { dateTime: `${t.inicio}:00`, timeZone: process.env.TZ },
        end: { dateTime: `${t.fin}:00`, timeZone: process.env.TZ },
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return ((await res.json()) as { id: string }).id;
  } catch (e) {
    console.error("Error agregando el turno a Google Calendar:", e);
    return null;
  }
}

export async function quitarDelCalendario(idEvento: string | null): Promise<void> {
  if (!calendarioActivo() || !idEvento) return;
  try {
    const res = await fetch(`${urlEventos()}/${encodeURIComponent(idEvento)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await tokenDeGoogle()}` },
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`${res.status} ${await res.text()}`);
  } catch (e) {
    console.error("Error quitando el turno de Google Calendar:", e);
  }
}

// --- Mercado Pago (seña del turno) ---

const MP = "https://api.mercadopago.com";

/** Monto de la seña de un servicio, o 0 si no se cobra seña (sin token o sin precio cargado). */
export function montoSena(servicio: string): number {
  const precio = agenda.precios?.[servicio];
  if (!config.mercadoPago.accessToken || !precio || config.mercadoPago.senaPorcentaje <= 0) return 0;
  return Math.round((precio * config.mercadoPago.senaPorcentaje) / 100);
}

/** Crea un link de pago para la seña del turno. Devuelve null si no corresponde o falla. */
export async function linkDeSena(t: Turno): Promise<{ link: string; monto: number } | null> {
  const monto = montoSena(t.servicio);
  if (!monto) return null;
  try {
    const res = await fetch(`${MP}/checkout/preferences`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.mercadoPago.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ title: `Seña turno #${t.id}: ${t.servicio}`, quantity: 1, unit_price: monto, currency_id: "ARS" }],
        external_reference: `turno-${t.id}`,
        ...(config.urlPublica && { notification_url: `${config.urlPublica}/mercadopago` }),
      }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return { link: ((await res.json()) as { init_point: string }).init_point, monto };
  } catch (e) {
    console.error("Error creando el link de Mercado Pago:", e);
    return null;
  }
}

/**
 * Consulta un pago en Mercado Pago (no se confía en lo que trae el webhook, se pregunta a la API)
 * y devuelve el número de turno si el pago está aprobado.
 */
export async function turnoDePagoAprobado(idPago: string): Promise<number | null> {
  const res = await fetch(`${MP}/v1/payments/${encodeURIComponent(idPago)}`, {
    headers: { Authorization: `Bearer ${config.mercadoPago.accessToken}` },
  });
  if (!res.ok) throw new Error(`Mercado Pago ${res.status}: ${await res.text()}`);
  const pago = (await res.json()) as { status: string; external_reference?: string };
  const id = /^turno-(\d+)$/.exec(pago.external_reference ?? "")?.[1];
  return pago.status === "approved" && id ? Number(id) : null;
}

// --- Transcripción de audios (OpenAI) ---

export const transcripcionActiva = () => !!config.openaiApiKey;

export async function transcribir(audio: Buffer, tipo: string): Promise<string> {
  const form = new FormData();
  const extension = tipo.split("/")[1]?.replace("mpeg", "mp3") ?? "ogg";
  form.append("file", new Blob([new Uint8Array(audio)], { type: tipo }), `audio.${extension}`);
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "es");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Error transcribiendo audio: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { text: string }).text.trim();
}
