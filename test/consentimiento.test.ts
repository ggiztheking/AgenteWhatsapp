// BAJA / ALTA y el aviso de que atiende un asistente automático: el cliente decide si recibe mensajes automáticos.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

Object.assign(process.env, {
  DB_PATH: ":memory:",
  WHATSAPP_TOKEN: "",
  DUENO_TELEFONO: "",
  WHATSAPP_PLANTILLA_RECORDATORIO: "recordatorio_cita",
  WHATSAPP_PLANTILLA_LUGAR_LIBRE: "lugar_libre",
  AVISO_PRIVACIDAD_URL: "https://agenda.ejemplo.mx/estilo-internacional/privacidad",
  MERCADOPAGO_ACCESS_TOKEN: "",
  GOOGLE_CALENDAR_ID: "",
  BARBERIA_URL: "",
});
mock.method(console, "log", () => {});

const { pideAlta, pideBaja, presentacion } = await import("../src/consentimiento.js");
const { ejecutarHerramienta } = await import("../src/herramientas.js");
const { enviarRecordatorios } = await import("../src/tareas.js");
const { escribirAlCliente } = await import("../src/whatsapp.js");
const { aFecha, diaDeLaSemana, fechaHoraLocal, fechaLocal, sumarDias } = await import("../src/fechas.js");
const memoria = await import("../src/memoria.js");

test("reconoce BAJA y ALTA solo cuando el mensaje es eso", () => {
  for (const t of ["BAJA", "baja.", " Baja ", "STOP", "Ya no me escribas", "no quiero recordatorios", "Dame de baja!"]) assert.ok(pideBaja(t), t);
  for (const t of ["quiero dar de baja mi cita del lunes", "¿la baja es gratis?", "hola", "alto fade"]) assert.ok(!pideBaja(t), t);
  for (const t of ["ALTA", "alta", "Dame de alta"]) assert.ok(pideAlta(t), t);
  assert.ok(!pideAlta("quiero un corte alto"));
});

test("el primer mensaje dice que es un asistente con IA, con el aviso de privacidad y cómo darse de baja", () => {
  const p = presentacion();
  assert.match(p, /asistente automático/);
  assert.match(p, /inteligencia artificial/);
  assert.match(p, /una persona/);
  assert.ok(p.includes("https://agenda.ejemplo.mx/estilo-internacional/privacidad"));
  assert.match(p, /\*BAJA\*/);
});

test("con BAJA no le llegan recordatorios ni avisos automáticos; con ALTA vuelven", async () => {
  const eva = { telefono: "5219990000009", nombreWhatsapp: "Eva" };
  let lunes = sumarDias(fechaLocal(new Date()), 7);
  while (diaDeLaSemana(lunes) !== "lunes") lunes = sumarDias(lunes, 1);
  await ejecutarHerramienta("agendar_cita", { fecha: lunes, hora: "11:30", servicio: "Corte y barba", nombre: "Eva" }, eva);
  const [cita] = memoria.turnosFuturosDe(eva.telefono, fechaHoraLocal(new Date()));
  const d = aFecha(cita.inicio), diaAntes = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 11, 0);

  const r = await ejecutarHerramienta("dejar_de_enviar_mensajes", {}, eva);
  assert.equal(r.error, false);
  assert.ok(memoria.estaDeBaja(eva.telefono));
  await enviarRecordatorios(diaAntes);
  assert.equal(memoria.turnoPorId(cita.id)!.recordado_en, null, "de baja no se le recuerda");
  assert.equal(await escribirAlCliente(eva.telefono, "Se liberó un lugar", "lugar_libre", []), false, "ni se le avisa de lugares libres");

  memoria.cambiarBaja(eva.telefono, false);
  assert.ok(!memoria.estaDeBaja(eva.telefono));
  await enviarRecordatorios(diaAntes);
  assert.ok(memoria.turnoPorId(cita.id)!.recordado_en, "con ALTA vuelve a recibirlos");
  assert.equal(await escribirAlCliente(eva.telefono, "Se liberó un lugar", "lugar_libre", []), true);
});

test("presentado y baja se guardan por cliente, sin pisarse", () => {
  const tel = "5219990000010";
  assert.ok(!memoria.fuePresentado(tel));
  memoria.marcarPresentado(tel);
  memoria.cambiarBaja(tel, true);
  assert.ok(memoria.fuePresentado(tel) && memoria.estaDeBaja(tel));
  memoria.cambiarBaja(tel, false);
  assert.ok(memoria.fuePresentado(tel), "quitar la baja no borra que ya se le presentó");
  assert.ok(!memoria.fuePresentado("5219990000011"));
});
