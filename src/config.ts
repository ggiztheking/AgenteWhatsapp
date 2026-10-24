import "dotenv/config";
import { readFileSync } from "node:fs";

process.env.TZ ||= "America/Argentina/Buenos_Aires";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? "data/agente.db",
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    appSecret: process.env.WHATSAPP_APP_SECRET ?? "",
    // Plantillas aprobadas en Meta (ver README). Vacías = desactivadas.
    plantillaAviso: process.env.WHATSAPP_PLANTILLA_AVISO ?? "",
    plantillaRecordatorio: process.env.WHATSAPP_PLANTILLA_RECORDATORIO ?? "",
    idiomaPlantillas: process.env.WHATSAPP_IDIOMA_PLANTILLAS || "es_AR",
  },
  // URL pública del servidor (ej. https://mi-agente.up.railway.app), para los webhooks de Mercado Pago.
  urlPublica: (process.env.URL_PUBLICA ?? "").replace(/\/$/, ""),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  mercadoPago: {
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN ?? "",
    senaPorcentaje: Number(process.env.MERCADOPAGO_SENA_PORCENTAJE || 30),
  },
  googleCalendar: {
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? "",
    // JSON completo de la cuenta de servicio, en una sola línea.
    cuentaServicio: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "",
  },
  duenoTelefono: process.env.DUENO_TELEFONO ?? "",
  // Pasadas estas horas sin mensajes, la conversación arranca de cero.
  horasParaNuevaConversacion: 24,
  // Hora (HH:MM) a la que el dueño recibe el resumen del día. Vacío = desactivado.
  resumenDiarioHora: process.env.RESUMEN_DIARIO_HORA ?? "",
};

export type Agenda = {
  intervaloMinutos: number;
  horarios: Record<string, [string, string][]>;
  servicios: Record<string, number>;
  diasCerrado: string[];
  // Opcionales: precio de cada servicio (para estimar facturación) y anticipación mínima para cancelar.
  precios?: Record<string, number>;
  anticipacionCancelarHoras?: number;
};

export const agenda: Agenda = JSON.parse(readFileSync("agenda.json", "utf8"));
for (const servicio of Object.keys(agenda.precios ?? {})) {
  if (!(servicio in agenda.servicios)) console.warn(`⚠️  agenda.json: "${servicio}" tiene precio pero no figura en servicios.`);
}
export const infoNegocio = readFileSync("negocio.md", "utf8");
