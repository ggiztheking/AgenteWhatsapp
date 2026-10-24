// Simula ser un cliente escribiendo por WhatsApp, sin necesitar Meta ni un número real.
// Uso: npm run chat
import { createInterface } from "node:readline/promises";
import { responder } from "./agente.js";
import { config } from "./config.js";

config.whatsapp.token = ""; // los avisos al dueño se muestran en pantalla en vez de enviarse

const telefono = "5219990000000";
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log("Chat de prueba. Escribe como si fueras un cliente (Ctrl+C para salir).");
if (config.barberia.url) {
  console.log(`⚠️  Las citas que agendes se guardan de verdad en ${config.barberia.url} (${config.barberia.slug}).`);
}
console.log();

while (true) {
  const texto = (await rl.question("Tú: ")).trim();
  if (!texto) continue;
  const respuesta = await responder(telefono, "Cliente de prueba", texto);
  console.log(`\nAgente: ${respuesta}\n`);
}
