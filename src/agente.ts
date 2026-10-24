import Anthropic from "@anthropic-ai/sdk";
import { infoNegocio } from "./config.js";
import { ahoraLegible } from "./fechas.js";
import { definicionesHerramientas, ejecutarHerramienta, type Contexto } from "./herramientas.js";
import * as memoria from "./memoria.js";

const client = new Anthropic();
const MAX_VUELTAS = 8;

const SYSTEM = `Eres el asistente de WhatsApp de este negocio. Atiendes a los clientes en nombre del negocio, en español de México, tuteando, con tono cálido y profesional.

Cómo responder:
- Mensajes cortos, como en un chat: 1 a 4 oraciones. Sin markdown ni títulos; puedes usar *negritas* de WhatsApp y algún emoji con moderación.
- Responde solo con la información del negocio que está abajo. Si algo no aparece, no lo inventes: di que lo consultas y usa derivar_a_humano.
- Para citas: pregunta qué paquete quiere (y si quiere extras), el día y si prefiere a algún barbero; consulta la disponibilidad, ofrece opciones, pide su nombre y confirma todo (con el total) antes de agendar.
- Para pedidos de productos: confirma productos, cantidades y nombre antes de registrar el pedido.
- Si el cliente pide hablar con una persona o está molesto, pásalo con una persona (derivar_a_humano).
- Cada mensaje del cliente trae la fecha y hora actual entre corchetes; úsala para interpretar "mañana", "el sábado", etc.
- Si al agendar te devuelven un link de anticipo, pásaselo al cliente tal cual y explícale que el anticipo asegura su cita.
- Si el cliente manda una foto, úsala para entender lo que pide (por ejemplo, el corte que quiere). Los audios te llegan ya transcritos.
- Las notas entre corchetes que dicen "Persona del negocio" son mensajes que le envió alguien del negocio mientras tú no atendías: tenlas en cuenta y no las contradigas.

Información del negocio:
<negocio>
${infoNegocio}
</negocio>`;

export type Imagen = { datos: Buffer; tipo: string };
const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** Procesa un mensaje del cliente y devuelve el texto a enviarle por WhatsApp. */
export async function responder(
  telefono: string,
  nombreWhatsapp: string | null,
  texto: string,
  imagen?: Imagen,
): Promise<string> {
  const conv = memoria.cargarConversacion(telefono);
  const mensajes = conv.mensajes;
  const ctx: Contexto = { telefono, nombreWhatsapp: nombreWhatsapp ?? conv.nombre };

  const encabezado = `[${ahoraLegible()}${ctx.nombreWhatsapp ? ` · nombre en WhatsApp: ${ctx.nombreWhatsapp}` : ""}]`;
  const tipoImagen = TIPOS_IMAGEN.find((t) => t === imagen?.tipo);
  mensajes.push({
    role: "user",
    content:
      imagen && tipoImagen
        ? [
            { type: "image", source: { type: "base64", media_type: tipoImagen, data: imagen.datos.toString("base64") } },
            { type: "text", text: `${encabezado}\n${texto || "(mandó esta imagen sin texto)"}` },
          ]
        : `${encabezado}\n${texto}`,
  });

  let respuesta = "";
  try {
    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      const msg = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system: SYSTEM,
        tools: definicionesHerramientas,
        messages: mensajes,
      });

      // Se guarda el contenido completo (incluye bloques de thinking), sin modificar.
      mensajes.push({ role: "assistant", content: msg.content });
      respuesta = msg.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      if (msg.stop_reason === "refusal") {
        respuesta = "Disculpa, con eso no te puedo ayudar por aquí. ¿Te ayudo con otra cosa?";
        break;
      }
      if (msg.stop_reason === "pause_turn") continue;
      if (msg.stop_reason !== "tool_use") break;

      const resultados: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const bloque of msg.content) {
        if (bloque.type !== "tool_use") continue;
        const r = await ejecutarHerramienta(bloque.name, bloque.input, ctx);
        console.log(`  🔧 ${bloque.name}(${JSON.stringify(bloque.input)}) → ${r.contenido}`);
        resultados.push({ type: "tool_result", tool_use_id: bloque.id, content: r.contenido, is_error: r.error });
      }
      mensajes.push({ role: "user", content: resultados });
    }
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      console.error("Límite de uso de la API de Claude alcanzado");
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Error de la API de Claude ${error.status}:`, error.message);
    } else {
      throw error;
    }
    // Se guarda igual: si una acción ya se ejecutó (ej. una cita), el agente lo sabrá en el próximo mensaje.
    memoria.guardarConversacion(telefono, ctx.nombreWhatsapp, mensajes);
    return "Perdón, tuve un problema técnico. ¿Me escribes de nuevo en un ratito?";
  }

  memoria.guardarConversacion(telefono, ctx.nombreWhatsapp, mensajes);
  return respuesta || "¿Me lo repites, por favor?";
}
