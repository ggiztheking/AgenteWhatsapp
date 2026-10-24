// Prueba las herramientas del agente contra un barberia-saas REAL (nunca el de producción).
// Uso: BARBERIA_PRUEBA_URL=http://localhost:4010 npm test
// Sin BARBERIA_PRUEBA_URL estas pruebas se omiten. barberia-saas permite 10 reservas por hora desde una misma IP:
// si se corre muchas veces seguidas, reinicia ese servidor.
import assert from "node:assert/strict";
import { test } from "node:test";

const url = process.env.BARBERIA_PRUEBA_URL ?? "";
const opciones = { skip: url ? false : "falta BARBERIA_PRUEBA_URL (un barberia-saas de prueba)" };

Object.assign(process.env, {
  DB_PATH: ":memory:",
  WHATSAPP_TOKEN: "",
  DUENO_TELEFONO: "",
  MERCADOPAGO_ACCESS_TOKEN: "",
  GOOGLE_CALENDAR_ID: "",
  BARBERIA_URL: url,
  BARBERIA_SLUG: "estilo-internacional",
});

const { ejecutarHerramienta, cancelar } = await import("../src/herramientas.js");
const barberia = await import("../src/barberia.js");
const memoria = await import("../src/memoria.js");
const { fechaLocal, sumarDias } = await import("../src/fechas.js");

const api = `${url}/api/estilo-internacional`;
// Celular de México tal como llega del webhook (521 + 10 dígitos). Uno distinto por corrida.
const sufijo = String(Date.now()).slice(-7);
const ctx = { telefono: `521999${sufijo}`, nombreWhatsapp: "Ana" };
// Un día lejano y distinto en cada corrida, para no chocar con citas de corridas anteriores.
const fecha = sumarDias(fechaLocal(new Date()), 30 + (Date.now() % 300));
const herramienta = async (nombre: string, input: unknown) => (await ejecutarHerramienta(nombre, input, ctx)).contenido;
const post = (ruta: string, cuerpo: object) =>
  fetch(`${api}${ruta}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });

let barberos: string[] = [];
let primera = "";

test("lee barberos y horario de la agenda real", opciones, async () => {
  const info = await barberia.info();
  barberos = info.barberos;
  primera = info.horas[0];
  assert.ok(barberos.length >= 2, "hacen falta al menos 2 barberos en la agenda de prueba (BARBEROS=Carlos,Miguel)");
  const r = await herramienta("consultar_disponibilidad", { fecha, barbero: "cualquiera" });
  assert.match(r, new RegExp(`${primera} \\(${barberos.join(", ")}\\)`));
});

test("agenda con paquete, extra y barbero; el precio lo calcula la agenda", opciones, async () => {
  const r = await herramienta("agendar_cita", {
    fecha,
    hora: primera,
    paquete: "corte y barba",
    extras: ["Cejas"],
    barbero: barberos[0],
    nombre: "Ana",
  });
  // Corte y barba $350 + Cejas $40.
  assert.match(r, new RegExp(`Cita #\\d+ confirmada: Corte y barba \\+ Cejas con ${barberos[0]}.*Total: \\$390 MXN`));
  const [turno] = memoria.turnosFuturosDe(ctx.telefono, `${fecha}T00:00`);
  assert.ok(turno.codigo, "guarda el código de la cita de barberia-saas");
  const [cita] = await barberia.citas([turno.codigo!]);
  assert.equal(cita.estado, "pendiente");
  assert.equal(cita.barbero, barberos[0]);
  assert.equal(cita.precio, 390);
});

test("ese espacio ya no se ofrece con ese barbero, pero sí con otro", opciones, async () => {
  const conElMismo = await herramienta("consultar_disponibilidad", { fecha, barbero: barberos[0] });
  assert.doesNotMatch(conElMismo, new RegExp(`^${primera} `, "m"));
  const cualquiera = await herramienta("consultar_disponibilidad", { fecha, barbero: "cualquiera" });
  assert.match(cualquiera, new RegExp(`${primera} \\(${barberos.slice(1).join(", ")}\\)`));
});

test("no se empalma con la página web: el mismo espacio rechaza otra reserva", opciones, async () => {
  const web = await post("/citas", {
    cliente: "Cliente web",
    telefono: "9990000000",
    servicio: "Elige tu corte",
    fecha,
    hora: primera,
    barbero: barberos[0],
  });
  assert.equal(web.status, 409);

  const segunda = (await barberia.info()).horas[1];
  const ocupadaPorWeb = await post("/citas", {
    cliente: "Cliente web",
    telefono: "9990000000",
    servicio: "Elige tu corte",
    fecha,
    hora: segunda,
    barbero: barberos[0],
  });
  assert.equal(ocupadaPorWeb.status, 200);
  const r = await herramienta("agendar_cita", {
    fecha,
    hora: segunda,
    paquete: "Elige tu corte",
    extras: [],
    barbero: barberos[0],
    nombre: "Ana",
  });
  assert.match(r, /La agenda respondió: Ese horario no está disponible/);
});

test("valida extras y barberos que no existen", opciones, async () => {
  const extra = await herramienta("agendar_cita", {
    fecha,
    hora: primera,
    paquete: "Elige tu corte",
    extras: ["Tinte"],
    barbero: "cualquiera",
    nombre: "Ana",
  });
  assert.match(extra, /No existe el extra "Tinte".*Cejas/);
  const barbero = await herramienta("consultar_disponibilidad", { fecha, barbero: "Pancho" });
  assert.match(barbero, /No hay un barbero llamado Pancho/);
});

test("si el cliente cancela desde la página, ya no aparece en sus citas", opciones, async () => {
  const r = await herramienta("agendar_cita", {
    fecha,
    hora: (await barberia.info()).horas[2],
    paquete: "Corte Fresco",
    extras: ["Lavado"],
    barbero: "cualquiera",
    nombre: "Ana",
  });
  // El lavado ya viene en Corte Fresco: la agenda no lo cobra.
  assert.match(r, /Total: \$280 MXN/);
  const turno = memoria.turnosFuturosDe(ctx.telefono, `${fecha}T00:00`).find((t) => t.servicio.startsWith("Corte Fresco"))!;
  assert.equal((await post("/cancelar", { codigo: turno.codigo })).status, 200);

  const mias = await herramienta("ver_mis_citas", {});
  assert.doesNotMatch(mias, /Corte Fresco/);
  assert.match(mias, /Corte y barba \+ Cejas/);
});

test("cambiar de horario mueve la misma cita en la agenda (mismo código y barbero)", opciones, async () => {
  const [turno] = memoria.turnosFuturosDe(ctx.telefono, `${fecha}T00:00`);
  const nueva = (await barberia.info()).horas[3];
  assert.match(await herramienta("reprogramar_cita", { cita_id: turno.id, fecha, hora: nueva }), new RegExp(`cambiada.*${nueva}`));
  const [cita] = await barberia.citas([turno.codigo!]);
  assert.equal(cita.hora, nueva);
  assert.equal(cita.barbero, barberos[0]);
  assert.equal(cita.estado, "pendiente");
  // De regreso a la hora original, para las pruebas que siguen.
  assert.match(await herramienta("reprogramar_cita", { cita_id: turno.id, fecha, hora: primera }), /cambiada/);
});

test("cancelar por WhatsApp libera el espacio en la agenda", opciones, async () => {
  const [turno] = memoria.turnosFuturosDe(ctx.telefono, `${fecha}T00:00`);
  assert.match(await herramienta("cancelar_cita", { cita_id: turno.id }), /cancelada/);
  const [cita] = await barberia.citas([turno.codigo!]);
  assert.equal(cita.estado, "cancelada");
  const libre = await herramienta("consultar_disponibilidad", { fecha, barbero: barberos[0] });
  assert.match(libre, new RegExp(`^${primera} `, "m"));
  // Cancelarla otra vez (por ejemplo, el dueño con /cancelar) no truena.
  assert.equal(await cancelar(turno.id, ctx.telefono), undefined);
});
