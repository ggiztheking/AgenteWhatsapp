// Lo que hace Sofía IA de AgendaPro, y más: recordatorio con confirmación, seguimiento si no contesta,
// cambio de horario, lista de espera que rescata citas canceladas y métricas de lo recuperado.
import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(process.env, {
  DB_PATH: ":memory:",
  WHATSAPP_TOKEN: "",
  DUENO_TELEFONO: "",
  WHATSAPP_PLANTILLA_RECORDATORIO: "recordatorio_cita",
  WHATSAPP_PLANTILLA_SEGUIMIENTO: "",
  WHATSAPP_PLANTILLA_LUGAR_LIBRE: "lugar_libre",
  MERCADOPAGO_ACCESS_TOKEN: "",
  GOOGLE_CALENDAR_ID: "",
  BARBERIA_URL: "",
});

const { ejecutarHerramienta } = await import("../src/herramientas.js");
const { enviarRecordatorios, enviarSeguimientos } = await import("../src/tareas.js");
const { resumen, agendaDelDia } = await import("../src/insights.js");
const { aFecha, diaDeLaSemana, fechaHoraLocal, fechaLocal, sumarDias } = await import("../src/fechas.js");
const memoria = await import("../src/memoria.js");

const ana = { telefono: "5219990000001", nombreWhatsapp: "Ana" };
const beto = { telefono: "5219990000002", nombreWhatsapp: "Beto" };
const caro = { telefono: "5219990000003", nombreWhatsapp: "Caro" };
const usar = async (nombre: string, input: unknown, ctx = ana) => (await ejecutarHerramienta(nombre, input, ctx)).contenido;
const ultimaNota = (tel: string) => String(memoria.cargarConversacion(tel).mensajes.at(-1)?.content ?? "");

let lunes = sumarDias(fechaLocal(new Date()), 7);
while (diaDeLaSemana(lunes) !== "lunes") lunes = sumarDias(lunes, 1);
const martes = sumarDias(lunes, 1);

/** Un momento del día anterior a la cita, a la hora indicada. */
const diaAntes = (inicio: string, hora: number) => {
  const d = aFecha(inicio);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, hora, 0);
};

test("el recordatorio no sale de noche ni demasiado pronto, y deja contexto para entender la respuesta", async () => {
  await usar("agendar_cita", { fecha: lunes, hora: "10:30", servicio: "Corte y barba", nombre: "Ana" });
  const [cita] = memoria.turnosFuturosDe(ana.telefono, fechaHoraLocal(new Date()));

  await enviarRecordatorios(diaAntes(cita.inicio, 6)); // 6 a. m.: muy temprano
  await enviarRecordatorios(diaAntes(cita.inicio, 22)); // 10 p. m.: muy tarde
  assert.equal(memoria.turnoPorId(cita.id)!.recordado_en, null);

  const dosDiasAntes = new Date(aFecha(cita.inicio).getTime() - 48 * 3600_000);
  await enviarRecordatorios(dosDiasAntes);
  assert.equal(memoria.turnoPorId(cita.id)!.recordado_en, null);

  await enviarRecordatorios(diaAntes(cita.inicio, 11));
  assert.ok(memoria.turnoPorId(cita.id)!.recordado_en);
  assert.match(ultimaNota(ana.telefono), /Recordatorio automático.*#\d+.*confirmar_cita/);
});

test("si el cliente suele escribir en la noche, se espera a esa hora para recordarle", async () => {
  const dani = { telefono: "5219990000004", nombreWhatsapp: "Dani" };
  // Su historial: siempre escribe a las 20 h.
  for (const dia of ["2026-01-05", "2026-01-12", "2026-01-19"]) memoria.registrarEvento("mensaje", dani.telefono, null, `${dia}T20:15`);
  assert.equal(memoria.horaHabitual(dani.telefono), 20);

  await usar("agendar_cita", { fecha: martes, hora: "21:30", servicio: "Elige tu corte", nombre: "Dani" }, dani);
  const [cita] = memoria.turnosFuturosDe(dani.telefono, fechaHoraLocal(new Date()));
  await enviarRecordatorios(diaAntes(cita.inicio, 10)); // faltan más de 14 h y no es su hora
  assert.equal(memoria.turnoPorId(cita.id)!.recordado_en, null);
  await enviarRecordatorios(diaAntes(cita.inicio, 20));
  assert.ok(memoria.turnoPorId(cita.id)!.recordado_en);
});

test("confirmar la cita la marca en la agenda del dueño", async () => {
  const [cita] = memoria.turnosFuturosDe(ana.telefono, fechaHoraLocal(new Date()));
  assert.match(agendaDelDia(lunes), /⏳ 10:30 · Corte y barba · Ana/);
  assert.match(await usar("confirmar_cita", { cita_id: cita.id }), /confirmada/);
  assert.match(agendaDelDia(lunes), /✅ 10:30 · Corte y barba · Ana/);
  // Una cita ya confirmada no recibe seguimiento.
  await enviarSeguimientos(diaAntes(cita.inicio, 18));
  assert.equal(memoria.turnoPorId(cita.id)!.confirmada, 1);
});

test("si no contesta el recordatorio, se le insiste una sola vez", async () => {
  await usar("agendar_cita", { fecha: lunes, hora: "12:30", servicio: "Elige tu corte", nombre: "Caro" }, caro);
  const [cita] = memoria.turnosFuturosDe(caro.telefono, fechaHoraLocal(new Date()));
  await enviarRecordatorios(diaAntes(cita.inicio, 11));
  assert.ok(memoria.turnoPorId(cita.id)!.recordado_en);
  memoria.registrarEvento("mensaje", caro.telefono); // su ventana de 24 h está abierta: va texto libre

  await enviarSeguimientos(diaAntes(cita.inicio, 13)); // solo 2 h después: todavía no
  assert.equal(memoria.turnoPorId(cita.id)!.seguimiento, 0);
  await enviarSeguimientos(diaAntes(cita.inicio, 16));
  assert.equal(memoria.turnoPorId(cita.id)!.seguimiento, 1);
  assert.match(ultimaNota(caro.telefono), /Seguimiento automático/);
});

test("cambia la cita de horario sin perderla", async () => {
  const [cita] = memoria.turnosFuturosDe(caro.telefono, fechaHoraLocal(new Date()));
  assert.match(await usar("reprogramar_cita", { cita_id: cita.id, fecha: martes, hora: "16:30" }, caro), /cambiada.*16:30/);
  const movida = memoria.turnoPorId(cita.id)!;
  assert.equal(movida.inicio, `${martes}T16:30`);
  assert.equal(movida.confirmada, 0);
  // Un horario ocupado no se puede tomar.
  assert.match(await usar("reprogramar_cita", { cita_id: cita.id, fecha: lunes, hora: "10:30" }, caro), /no está disponible/);
});

test("lista de espera: al cancelar, se avisa al que esperaba y su cita cuenta como rescatada", async () => {
  // Se llena el lunes de las 13:30 en adelante con un cliente de relleno.
  const relleno = { telefono: "5219990000009", nombreWhatsapp: "Relleno" };
  const libres = (await usar("consultar_disponibilidad", { fecha: lunes, servicio: "Elige tu corte" })).split(": ")[1].split(", ");
  for (const h of libres) await usar("agendar_cita", { fecha: lunes, hora: h, servicio: "Elige tu corte", nombre: "Relleno" }, relleno);
  assert.match(await usar("consultar_disponibilidad", { fecha: lunes, servicio: "Elige tu corte" }, beto), /No hay horarios/);

  assert.match(await usar("apuntar_lista_espera", { fecha: lunes, barbero: "cualquiera" }, beto), /lista de espera/);
  // Ana cancela su cita del lunes: se libera su lugar y Beto recibe el aviso.
  const [deAna] = memoria.turnosFuturosDe(ana.telefono, fechaHoraLocal(new Date()));
  assert.match(await usar("cancelar_cita", { cita_id: deAna.id }), /cancelada/);
  assert.match(ultimaNota(beto.telefono), /lista de espera.*10:30/);
  assert.equal(memoria.enEsperaPara(lunes).length, 0);

  assert.match(await usar("agendar_cita", { fecha: lunes, hora: "10:30", servicio: "VIP Diamante", nombre: "Beto" }, beto), /confirmada/);
  const r = resumen("hoy");
  assert.match(r, /1 apuntados · 1 avisados · 1 citas rescatadas \(\$450 MXN que se iban a perder\)/);
  assert.match(r, /Confirmaron su cita: 1 · cambiaron de horario: 1/);
});
