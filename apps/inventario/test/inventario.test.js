// Reglas propias del inventario: las existencias se mueven solas con cada entrada, venta o ajuste.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { crearApp } from "../app.js";

const ADMIN_URL = process.env.DATABASE_URL_ADMIN;
const opciones = { skip: ADMIN_URL ? false : "falta DATABASE_URL_ADMIN" };
const nombreDb = `prueba_inv_${Date.now().toString(36)}_${process.pid}`;
let servidor, base, pool, dbApp, cookie = "";

async function api(ruta, metodo = "GET", datos) {
  const r = await fetch(base + "/api" + ruta, {
    method: metodo,
    headers: { ...(datos ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: datos ? JSON.stringify(datos) : undefined,
  });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}
const existencias = async (id) => (await api(`/t/productos/${id}`)).json.fila.existencias;

before(async () => {
  if (!ADMIN_URL) return;
  pool = new pg.Pool({ connectionString: ADMIN_URL });
  await pool.query(`CREATE DATABASE ${nombreDb}`);
  const u = new URL(ADMIN_URL);
  u.pathname = "/" + nombreDb;
  const creada = await crearApp({ databaseUrl: u.toString() });
  dbApp = creada.db;
  await new Promise((ok) => (servidor = creada.app.listen(0, "127.0.0.1", ok)));
  base = `http://127.0.0.1:${servidor.address().port}`;
  await api("/_primer-admin", "POST", { nombre: "Dueño", correo: "dueno@ejemplo.com", clave: "clave-segura-1" });
});

after(async () => {
  if (!ADMIN_URL) return;
  await new Promise((ok) => servidor.close(ok));
  await dbApp.end();
  await pool.query(`DROP DATABASE IF EXISTS ${nombreDb} WITH (FORCE)`);
  await pool.end();
});

test("entradas suman, ventas restan y calculan su total, y borrar regresa las existencias", opciones, async () => {
  const p = (await api("/t/productos", "POST", { nombre: "Pomada mate", categoria: "Pomada", precio: 180, existencias: 0, minimo: 2, activo: true })).json.fila;
  const entrada = await api("/t/movimientos", "POST", { producto: p.id, tipo: "Entrada", cantidad: 10, fecha: "2026-11-02" });
  assert.equal(entrada.status, 201);
  assert.equal(await existencias(p.id), 10);

  const venta = await api("/t/movimientos", "POST", { producto: p.id, tipo: "Venta", cantidad: 3, fecha: "2026-11-02" });
  assert.equal(venta.status, 201);
  assert.equal(venta.json.fila.total, 540);
  assert.equal(await existencias(p.id), 7);

  // Editar la venta de 3 a 5 piezas mueve la diferencia.
  assert.equal((await api(`/t/movimientos/${venta.json.fila.id}`, "PUT", { cantidad: 5 })).status, 200);
  assert.equal(await existencias(p.id), 5);

  assert.equal((await api(`/t/movimientos/${venta.json.fila.id}`, "DELETE")).status, 200);
  assert.equal(await existencias(p.id), 10);
});

test("no deja vender más de lo que hay y avisa cuánto queda", opciones, async () => {
  const p = (await api("/t/productos", "POST", { nombre: "Cera brillo", categoria: "Cera", precio: 150, existencias: 2, minimo: 3, activo: true })).json.fila;
  const r = await api("/t/movimientos", "POST", { producto: p.id, tipo: "Venta", cantidad: 5, fecha: "2026-11-02" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /quedan 2/);
  assert.equal(await existencias(p.id), 2);
  assert.equal((await api("/t/movimientos", "POST", { producto: p.id, tipo: "Venta", cantidad: 0, fecha: "2026-11-02" })).status, 400);
});

test("por surtir: los productos en su mínimo o abajo", opciones, async () => {
  const lista = (await api("/por-surtir")).json;
  assert.ok(lista.some((p) => p.nombre === "Cera brillo"));
  assert.ok(!lista.some((p) => p.nombre === "Pomada mate"));
});
