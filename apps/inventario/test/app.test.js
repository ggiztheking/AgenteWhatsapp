// Pruebas que sirven para cualquier app: leen modelo.json y prueban cada sección contra un PostgreSQL real
// (una base nueva por corrida, que se borra al final). Necesitan DATABASE_URL_ADMIN, por ejemplo
// postgres://postgres@localhost:5434/postgres; sin ella se omiten. apps/_herramientas/probar.sh la pone sola.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { crearApp } from "../app.js";

const ADMIN_URL = process.env.DATABASE_URL_ADMIN;
const opciones = { skip: ADMIN_URL ? false : "falta DATABASE_URL_ADMIN" };
const nombreDb = `prueba_${Date.now().toString(36)}_${process.pid}`;
let servidor, base, modelo, pool;

function urlDe(db) {
  const u = new URL(ADMIN_URL);
  u.pathname = "/" + db;
  return u.toString();
}

/** Un cliente con su propia cookie de sesión, como un navegador. */
function cliente(origen) {
  let cookie = "";
  return async (ruta, { metodo = "GET", datos, cabeceras = {} } = {}) => {
    const r = await fetch(base + ruta, {
      method: metodo,
      headers: { ...(datos ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origen ? { Origin: origen } : {}), ...cabeceras },
      body: datos ? JSON.stringify(datos) : undefined,
      redirect: "manual",
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const texto = await r.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    return { status: r.status, json, texto, tipo: r.headers.get("content-type") ?? "" };
  };
}

/** Un valor de ejemplo válido para cada tipo de campo. */
function ejemplo(c, ids, n = 1) {
  switch (c.tipo) {
    case "texto": return `Prueba ${c.nombre} ${n}`;
    case "texto_largo": return `Texto largo de prueba ${n}`;
    case "correo": return `prueba${n}@ejemplo.com`;
    case "telefono": return "9991234567";
    case "url": return "https://ejemplo.com";
    case "numero": return Math.max(5 * n, c.minimo ?? 0);
    case "dinero": return Math.max(123.45 * n, c.minimo ?? 0);
    case "fecha": return "2026-11-02";
    case "fecha_hora": return "2026-11-02T15:30:00.000Z";
    case "si_no": return true;
    case "opcion": return c.opciones[0];
    case "relacion": return ids[c.tabla];
  }
}

/** Las tablas en un orden en que cada una va después de las que usa. */
function ordenadas(m) {
  const listas = [];
  const pendientes = [...m.tablas];
  while (pendientes.length) {
    const i = pendientes.findIndex((t) => t.campos.every((c) => c.tipo !== "relacion" || c.tabla === t.id || listas.some((x) => x.id === c.tabla)));
    listas.push(...pendientes.splice(i === -1 ? 0 : i, 1));
  }
  return listas;
}

before(async () => {
  if (!ADMIN_URL) return;
  pool = new pg.Pool({ connectionString: ADMIN_URL });
  await pool.query(`CREATE DATABASE ${nombreDb}`);
  const creada = await crearApp({ databaseUrl: urlDe(nombreDb) });
  modelo = creada.modelo;
  await new Promise((ok) => (servidor = creada.app.listen(0, "127.0.0.1", ok)));
  base = `http://127.0.0.1:${servidor.address().port}`;
  globalThis.__dbApp = creada.db;
});

after(async () => {
  if (!ADMIN_URL) return;
  await new Promise((ok) => servidor?.close(ok));
  await globalThis.__dbApp?.end();
  await pool.query(`DROP DATABASE IF EXISTS ${nombreDb} WITH (FORCE)`);
  await pool.end();
});

const admin = cliente();
const ids = {};

test("la primera persona crea la cuenta de administrador, y solo ella", opciones, async () => {
  assert.equal((await admin("/api/_estado")).json.configurada, false);
  assert.equal((await admin("/api/_salud")).status, 200);
  assert.equal((await admin("/api/_modelo")).status, 401);
  const r = await admin("/api/_primer-admin", { metodo: "POST", datos: { nombre: "Ana", correo: "ana@ejemplo.com", clave: "clave-segura-1" } });
  assert.equal(r.status, 200, r.texto);
  const otro = cliente();
  assert.equal((await otro("/api/_primer-admin", { metodo: "POST", datos: { nombre: "X", correo: "x@ejemplo.com", clave: "clave-segura-2" } })).status, 409);
  const estado = (await admin("/api/_estado")).json;
  assert.equal(estado.usuario.rol, "admin");
});

test("entrar: contraseña mala no, buena sí", opciones, async () => {
  const c = cliente();
  assert.equal((await c("/api/_entrar", { metodo: "POST", datos: { correo: "ana@ejemplo.com", clave: "mala-mala" } })).status, 401);
  assert.equal((await c("/api/_entrar", { metodo: "POST", datos: { correo: "ANA@ejemplo.com", clave: "clave-segura-1" } })).status, 200);
  assert.equal((await c("/api/_modelo")).status, 200);
});

test("cada sección: crear, ver, listar, buscar, editar y exportar", opciones, async () => {
  const m = (await admin("/api/_modelo")).json;
  assert.equal(m.tablas.length, modelo.tablas.length);
  for (const t of ordenadas(modelo)) {
    const datos = Object.fromEntries(t.campos.map((c) => [c.id, ejemplo(c, ids)]));
    const r = await admin(`/api/t/${t.id}`, { metodo: "POST", datos });
    assert.equal(r.status, 201, `${t.id}: ${r.texto}`);
    ids[t.id] = r.json.fila.id;

    const uno = await admin(`/api/t/${t.id}/${ids[t.id]}`);
    assert.equal(uno.status, 200);
    for (const c of t.campos.filter((c) => ["texto", "opcion", "correo", "fecha"].includes(c.tipo))) assert.equal(uno.json.fila[c.id], datos[c.id], `${t.id}.${c.id}`);

    const lista = await admin(`/api/t/${t.id}`);
    assert.ok(lista.json.filas.some((f) => f.id === ids[t.id]), `${t.id} aparece en la lista`);
    const texto = t.campos.find((c) => c.tipo === "texto");
    if (texto) {
      assert.equal((await admin(`/api/t/${t.id}?q=${encodeURIComponent(datos[texto.id])}`)).json.total >= 1, true);
      assert.equal((await admin(`/api/t/${t.id}?q=zzz-no-existe-zzz`)).json.total, 0);
      const ed = await admin(`/api/t/${t.id}/${ids[t.id]}`, { metodo: "PUT", datos: { [texto.id]: datos[texto.id] + " editado" } });
      assert.equal(ed.status, 200, ed.texto);
      assert.equal(ed.json.fila[texto.id], datos[texto.id] + " editado");
    }
    for (const c of t.campos.filter((c) => c.tipo === "relacion")) {
      const conEt = await admin(`/api/t/${t.id}`);
      assert.ok(conEt.json.etiquetas[c.id]?.[ids[c.tabla]], `${t.id}.${c.id} trae el nombre del registro relacionado`);
    }
    const csv = await admin(`/api/t/${t.id}/csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.tipo, /text\/csv/);
    assert.ok(csv.texto.includes(t.campos[0].nombre), `${t.id}: CSV con encabezados`);
  }
  const resumen = (await admin("/api/_resumen")).json;
  assert.ok(resumen.every((r) => r.total >= 1));
});

test("valida los datos y explica qué falta", opciones, async () => {
  for (const t of modelo.tablas) {
    const req = t.campos.find((c) => c.requerido);
    if (req) {
      const r = await admin(`/api/t/${t.id}`, { metodo: "POST", datos: {} });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /Falta/);
    }
    const num = t.campos.find((c) => c.tipo === "numero" || c.tipo === "dinero");
    if (num) {
      const r = await admin(`/api/t/${t.id}/${ids[t.id]}`, { metodo: "PUT", datos: { [num.id]: "no es número" } });
      assert.equal(r.status, 400);
    }
    const op = t.campos.find((c) => c.tipo === "opcion");
    if (op) assert.equal((await admin(`/api/t/${t.id}/${ids[t.id]}`, { metodo: "PUT", datos: { [op.id]: "inventada" } })).status, 400);
  }
  assert.equal((await admin("/api/t/no_existe")).status, 404);
});

test("un lector ve pero no edita; un editor no administra usuarios", opciones, async () => {
  for (const [rol, correo] of [["lector", "luis@ejemplo.com"], ["editor", "eva@ejemplo.com"]])
    assert.equal((await admin("/api/_usuarios", { metodo: "POST", datos: { nombre: rol, correo, rol, clave: "clave-segura-3" } })).status, 200);
  const lector = cliente();
  await lector("/api/_entrar", { metodo: "POST", datos: { correo: "luis@ejemplo.com", clave: "clave-segura-3" } });
  const t = modelo.tablas.find((t) => t.permisos.leer.includes("lector"));
  if (t) {
    assert.equal((await lector(`/api/t/${t.id}`)).status, 200);
    assert.equal((await lector(`/api/t/${t.id}`, { metodo: "POST", datos: {} })).status, 403);
  }
  const editor = cliente();
  await editor("/api/_entrar", { metodo: "POST", datos: { correo: "eva@ejemplo.com", clave: "clave-segura-3" } });
  assert.equal((await editor("/api/_usuarios")).status, 403);
  assert.equal((await editor("/api/_historial")).status, 403);
});

test("el historial registra quién cambió qué", opciones, async () => {
  const h = (await admin("/api/_historial")).json;
  for (const t of modelo.tablas) assert.ok(h.some((x) => x.tabla === t.id && x.accion === "crear" && x.usuario === "Ana"), `historial de ${t.id}`);
});

test("no se puede dejar la app sin administrador", opciones, async () => {
  const yo = (await admin("/api/_estado")).json.usuario;
  assert.equal((await admin(`/api/_usuarios/${yo.id}`, { metodo: "PUT", datos: { rol: "lector" } })).status, 400);
});

test("escrituras desde otro sitio se rechazan", opciones, async () => {
  const ajeno = cliente("https://sitio-malo.com");
  await ajeno("/api/_entrar", { metodo: "POST", datos: { correo: "ana@ejemplo.com", clave: "clave-segura-1" } });
  const t = modelo.tablas[0];
  assert.equal((await ajeno(`/api/t/${t.id}`, { metodo: "POST", datos: {} })).status, 403);
});

test("borrar respeta lo que otros registros usan", opciones, async () => {
  const usadas = new Set(modelo.tablas.flatMap((t) => t.campos.filter((c) => c.tipo === "relacion" && c.tabla !== t.id).map((c) => c.tabla)));
  for (const id of usadas) assert.equal((await admin(`/api/t/${id}/${ids[id]}`, { metodo: "DELETE" })).status, 409, `${id} está en uso`);
  for (const t of ordenadas(modelo).reverse()) {
    const r = await admin(`/api/t/${t.id}/${ids[t.id]}`, { metodo: "DELETE" });
    assert.equal(r.status, 200, `${t.id}: ${r.texto}`);
    assert.equal((await admin(`/api/t/${t.id}/${ids[t.id]}`)).status, 404);
  }
});

test("sirve las pantallas y da 404 a archivos que no existen", opciones, async () => {
  const c = cliente();
  const pantalla = await c("/t/algo");
  assert.equal(pantalla.status, 200);
  assert.match(pantalla.tipo, /text\/html/);
  assert.equal((await c("/no-existe.js")).status, 404);
  assert.equal((await c("/ui.js")).status, 200);
});
