// Lo que el cliente debe saber y poder decidir: que lo atiende un asistente automático (con el aviso de privacidad)
// y que puede dejar de recibir mensajes automáticos escribiendo BAJA (y volver con ALTA).
import { config } from "./config.js";

const normal = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Solo mensajes que son únicamente eso: "baja" dentro de otra frase ("¿y si me doy de baja la cita?") lo atiende el agente.
const BAJA = new Set([
  "baja", "stop", "alto", "darme de baja", "dame de baja", "dar de baja", "de baja", "no me escribas", "ya no me escribas",
  "no me manden mensajes", "ya no me manden mensajes", "no quiero mensajes", "ya no quiero mensajes", "no quiero recordatorios",
]);
const ALTA = new Set(["alta", "darme de alta", "dame de alta", "start"]);

export const pideBaja = (texto: string) => BAJA.has(normal(texto));
export const pideAlta = (texto: string) => ALTA.has(normal(texto));

export const MENSAJE_BAJA =
  "Listo, ya no te mandaremos mensajes automáticos (recordatorios ni avisos de lugares libres). " +
  "Si nos escribes, te seguimos atendiendo. Si cambias de opinión, escribe *ALTA*.";
export const MENSAJE_ALTA = "¡Listo! Vuelves a recibir los recordatorios de tus citas. Para dejar de recibirlos escribe *BAJA*.";

/** Primer mensaje a cada cliente: quién lo atiende, su aviso de privacidad y cómo darse de baja. */
export function presentacion(): string {
  return (
    "👋 Te atiende el asistente automático de la barbería, con inteligencia artificial. Si prefieres a una persona, solo dímelo." +
    (config.avisoPrivacidad ? ` Aviso de privacidad: ${config.avisoPrivacidad}` : "") +
    " Para no recibir mensajes automáticos, escribe *BAJA*."
  );
}
