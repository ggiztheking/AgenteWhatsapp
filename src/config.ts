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
  },
  duenoTelefono: process.env.DUENO_TELEFONO ?? "",
  // Pasadas estas horas sin mensajes, la conversación arranca de cero.
  horasParaNuevaConversacion: 24,
};

export type Agenda = {
  intervaloMinutos: number;
  horarios: Record<string, [string, string][]>;
  servicios: Record<string, number>;
  diasCerrado: string[];
};

export const agenda: Agenda = JSON.parse(readFileSync("agenda.json", "utf8"));
export const infoNegocio = readFileSync("negocio.md", "utf8");
