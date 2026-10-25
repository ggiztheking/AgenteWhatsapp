// Envío de correos con Resend (opcional: RESEND_API_KEY y CORREO_REMITENTE). Sin clave, solo lo anota en
// la consola, así la app funciona igual mientras se configura.
export async function enviarCorreo({ para, asunto, html }) {
  const clave = process.env.RESEND_API_KEY;
  if (!clave) {
    console.log(`[correo sin enviar: falta RESEND_API_KEY] para ${para}: ${asunto}`);
    return { enviado: false };
  }
  const r = await fetch(process.env.RESEND_URL || "https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${clave}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.CORREO_REMITENTE || "Avisos <onboarding@resend.dev>", to: [].concat(para), subject: asunto, html }),
  });
  if (!r.ok) throw new Error(`Resend respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { enviado: true };
}
