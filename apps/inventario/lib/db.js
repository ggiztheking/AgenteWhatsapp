// Conexión a PostgreSQL y migraciones: crea las tablas del sistema y las del modelo. Solo agrega
// (tablas y columnas nuevas); nunca borra, así un cambio en modelo.json no pierde datos.
import pg from "pg";
import { TIPOS } from "./modelo.js";

// Fechas como texto (AAAA-MM-DD) y números como número, no como objetos ni texto.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export async function crearDb(url, modelo) {
  if (!url) throw new Error("Falta DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _usuarios (
      id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, correo TEXT NOT NULL UNIQUE, rol TEXT NOT NULL,
      sal TEXT NOT NULL, hash TEXT NOT NULL, activo BOOLEAN NOT NULL DEFAULT true,
      creado TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS _sesiones (
      token TEXT PRIMARY KEY, usuario INTEGER NOT NULL REFERENCES _usuarios(id) ON DELETE CASCADE,
      expira TIMESTAMPTZ NOT NULL);
    CREATE TABLE IF NOT EXISTS _historial (
      id SERIAL PRIMARY KEY, usuario INTEGER, tabla TEXT NOT NULL, registro INTEGER, accion TEXT NOT NULL,
      cambios JSONB, fecha TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS _historial_fecha ON _historial (fecha DESC);
    CREATE TABLE IF NOT EXISTS _pagos (
      id TEXT PRIMARY KEY, tabla TEXT NOT NULL, registro INTEGER NOT NULL, monto NUMERIC(14,2),
      estado TEXT NOT NULL, fecha TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  // Los nombres de tablas y campos ya están validados por modelo.js (solo a-z, 0-9 y _), así que se pueden
  // poner entre comillas en el SQL sin riesgo.
  for (const t of modelo.tablas) {
    await pool.query(`CREATE TABLE IF NOT EXISTS "${t.id}" (
      id SERIAL PRIMARY KEY, creado TIMESTAMPTZ NOT NULL DEFAULT now(), actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
      creado_por INTEGER)`);
    for (const c of t.campos) await pool.query(`ALTER TABLE "${t.id}" ADD COLUMN IF NOT EXISTS "${c.id}" ${TIPOS[c.tipo]}`);
  }
  setInterval(() => pool.query("DELETE FROM _sesiones WHERE expira < now()").catch(() => {}), 3600_000).unref();
  return pool;
}
