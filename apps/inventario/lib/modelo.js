// Lee y valida modelo.json: la descripción de la app (sus secciones y campos) de la que sale todo lo demás:
// las tablas de la base, la API y las pantallas.
import { readFileSync } from "node:fs";

/** Tipos de campo y su columna en PostgreSQL. */
export const TIPOS = {
  texto: "TEXT",
  texto_largo: "TEXT",
  numero: "NUMERIC",
  dinero: "NUMERIC(14,2)",
  fecha: "DATE",
  fecha_hora: "TIMESTAMPTZ",
  si_no: "BOOLEAN",
  opcion: "TEXT",
  correo: "TEXT",
  telefono: "TEXT",
  url: "TEXT",
  relacion: "INTEGER",
};

export const ROLES = ["lector", "editor", "admin"];
const ID = /^[a-z][a-z0-9_]{0,40}$/;
const RESERVADOS = new Set(["id", "creado", "actualizado", "creado_por"]);

function falla(msg) {
  throw new Error(`modelo.json: ${msg}`);
}

export function validarModelo(m) {
  if (!m || typeof m !== "object") falla("no es un objeto");
  if (!m.nombre) falla("falta nombre");
  if (!Array.isArray(m.tablas) || !m.tablas.length) falla("falta tablas");
  const ids = new Set();
  for (const t of m.tablas) {
    if (!ID.test(t.id ?? "")) falla(`id de tabla inválido: ${t.id}`);
    if (ids.has(t.id)) falla(`tabla repetida: ${t.id}`);
    ids.add(t.id);
    t.nombre ||= t.id;
    t.singular ||= t.nombre;
    if (!Array.isArray(t.campos) || !t.campos.length) falla(`la tabla ${t.id} no tiene campos`);
    const campos = new Set();
    for (const c of t.campos) {
      if (!ID.test(c.id ?? "") || RESERVADOS.has(c.id)) falla(`campo inválido en ${t.id}: ${c.id}`);
      if (campos.has(c.id)) falla(`campo repetido en ${t.id}: ${c.id}`);
      campos.add(c.id);
      if (!TIPOS[c.tipo]) falla(`tipo desconocido en ${t.id}.${c.id}: ${c.tipo}`);
      c.nombre ||= c.id;
      if (c.tipo === "opcion" && (!Array.isArray(c.opciones) || !c.opciones.length)) falla(`${t.id}.${c.id} necesita opciones`);
    }
    t.permisos = { leer: ["lector", "editor", "admin"], escribir: ["editor", "admin"], ...(t.permisos ?? {}) };
    for (const r of [...t.permisos.leer, ...t.permisos.escribir]) if (!ROLES.includes(r)) falla(`rol desconocido en ${t.id}: ${r}`);
    if (!t.permisos.leer.includes("admin")) t.permisos.leer.push("admin");
    if (!t.permisos.escribir.includes("admin")) t.permisos.escribir.push("admin");
    t.etiqueta ||= (t.campos.find((c) => c.tipo === "texto") ?? t.campos[0]).id;
    if (!campos.has(t.etiqueta)) falla(`etiqueta de ${t.id} no es un campo: ${t.etiqueta}`);
  }
  for (const t of m.tablas)
    for (const c of t.campos)
      if (c.tipo === "relacion" && !ids.has(c.tabla)) falla(`${t.id}.${c.id} apunta a una tabla que no existe: ${c.tabla}`);
  m.porId = Object.fromEntries(m.tablas.map((t) => [t.id, t]));
  return m;
}

export function cargarModelo(ruta) {
  return validarModelo(JSON.parse(readFileSync(ruta, "utf8")));
}

export const puede = (usuario, tabla, accion) => !!usuario && tabla.permisos[accion].includes(usuario.rol);

/** Lo que el navegador necesita del modelo, solo con las tablas que ese usuario puede ver. */
export function modeloPara(m, usuario) {
  return {
    nombre: m.nombre,
    descripcion: m.descripcion ?? "",
    color: m.color ?? "",
    tablas: m.tablas
      .filter((t) => puede(usuario, t, "leer"))
      .map(({ id, nombre, singular, descripcion, campos, etiqueta, icono }) => ({
        id,
        nombre,
        singular,
        descripcion: descripcion ?? "",
        icono: icono ?? "",
        etiqueta,
        campos,
        escribir: puede(usuario, m.porId[id], "escribir"),
      })),
  };
}
