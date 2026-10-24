// Simula ser un cliente escribiendo por WhatsApp, sin necesitar Meta ni un número real.
// Uso: npm run chat
import { createInterface } from "node:readline/promises";
import { responder } from "./agente.js";
import { config } from "./config.js";

config.whatsapp.token = ""; // los avisos al dueño se muestran en pantalla en vez de enviarse

const telefono = "5490000000000";
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log("Chat de prueba. Escribí como si fueras un cliente (Ctrl+C para salir).\n");

while (true) {
  const texto = (await rl.question("Vos: ")).trim();
  if (!texto) continue;
  const respuesta = await responder(telefono, "Cliente de prueba", texto);
  console.log(`\nAgente: ${respuesta}\n`);
}
