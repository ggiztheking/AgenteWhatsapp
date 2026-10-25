// API de cada sección del modelo: listar (con búsqueda y orden), ver, crear, editar, borrar y exportar a CSV.
// Todo cambio queda en el historial. personalizado.js puede engancharse antes o después de guardar.
import { modeloPara, puede } from "./modelo.js";

const BUSCABLES = new Set(["texto", "texto_largo", "correo", "telefono", "opcion", "url"]);

export class ErrorDeDatos extends Error {}

/** Convierte lo que manda el navegador al tipo del campo, o lanza un error que entiende la persona. */
function limpiar(c, v) {
  const vacio = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  if (vacio) {
    if (c.requerido) throw new ErrorDeDatos(`Falta ${c.nombre}`);
    return c.tipo === "si_no" ? false : null;
  }
  const t = typeof v === "string" ? v.trim() : v;
  switch (c.tipo) {
    case "texto":
    case "telefono":
      return String(t).slice(0, 500);
    case "texto_largo":
      return String(t).slice(0, 20000);
    case "correo":
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(t))) throw new ErrorDeDatos(`${c.nombre}: escribe un correo válido`);
      return String(t).toLowerCase();
    case "url":
      if (!/^https?:\/\/\S+$/i.test(String(t))) throw new ErrorDeDatos(`${c.nombre}: escribe una dirección que empiece con https://`);
      return String(t);
    case "numero":
    case "dinero": {
      const n = Number(typeof t === "string" ? t.replace(/[$,\s]/g, "") : t);
      if (!Number.isFinite(n)) throw new ErrorDeDatos(`${c.nombre}: escribe un número`);
      if (c.minimo !== undefined && n < c.minimo) throw new ErrorDeDatos(`${c.nombre}: no puede ser menor que ${c.minimo}`);
      return c.tipo === "dinero" ? Math.round(n * 100) / 100 : n;
    }
    case "fecha":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t))) throw new ErrorDeDatos(`${c.nombre}: escribe una fecha`);
      return String(t);
    case "fecha_hora": {
      const d = new Date(t);
      if (Number.isNaN(+d)) throw new ErrorDeDatos(`${c.nombre}: escribe fecha y hora`);
      return d.toISOString();
    }
    case "si_no":
      return t === true || t === "true" || t === "si" || t === "sí" || t === 1 || t === "1";
    case "opcion":
      if (!c.opciones.includes(String(t))) throw new ErrorDeDatos(`${c.nombre}: elige una de las opciones`);
      return String(t);
    case "relacion": {
      const n = Number(t);
      if (!Number.isInteger(n) || n <= 0) throw new ErrorDeDatos(`${c.nombre}: elige una opción de la lista`);
      return n;
    }
  }
  return t;
}

const csvCelda = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Una celda que empieza con = + - @ se abriría como fórmula en Excel: se le antepone un apóstrofo.
  const seguro = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\n;]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
};

export function rutasCrud(app, db, modelo, { requiere }) {
  const ganchos = { antes: [], despues: [] };

  /** La tabla del pedido, si existe y el usuario puede hacer esa acción; si no, responde el error. */
  const tablaDe = (q, s, accion) => {
    const t = modelo.porId[q.params.tabla];
    if (!t || !puede(q.usuario, t, "leer")) {
      s.status(404).json({ error: "Esa sección no existe" });
      return null;
    }
    if (accion === "escribir" && !puede(q.usuario, t, "escribir")) {
      s.status(403).json({ error: "Tu cuenta solo puede ver esta sección" });
      return null;
    }
    return t;
  };

  const idDe = (q, s) => {
    const id = Number(q.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      s.status(404).json({ error: "No existe ese registro" });
      return null;
    }
    return id;
  };

  /** Para cada campo de relación, los nombres de los registros a los que apuntan las filas. */
  async function etiquetas(t, filas) {
    const res = {};
    for (const c of t.campos.filter((c) => c.tipo === "relacion")) {
      const ids = [...new Set(filas.map((f) => f[c.id]).filter(Boolean))];
      if (!ids.length) continue;
      const otra = modelo.porId[c.tabla];
      const r = await db.query(`SELECT id, "${otra.etiqueta}" AS e FROM "${otra.id}" WHERE id = ANY($1)`, [ids]);
      res[c.id] = Object.fromEntries(r.rows.map((x) => [x.id, x.e]));
    }
    return res;
  }

  /** Revisa los datos de un registro nuevo o editado (parcial: solo los campos que vienen). */
  async function datosDe(t, cuerpo, parcial) {
    const datos = {};
    for (const c of t.campos) {
      if (parcial && !(c.id in (cuerpo ?? {}))) continue;
      datos[c.id] = limpiar(c, cuerpo?.[c.id]);
      if (c.tipo === "relacion" && datos[c.id] !== null) {
        const r = await db.query(`SELECT 1 FROM "${c.tabla}" WHERE id = $1`, [datos[c.id]]);
        if (!r.rowCount) throw new ErrorDeDatos(`${c.nombre}: esa opción ya no existe`);
      }
    }
    return datos;
  }

  async function correrGanchos(cuando, contexto) {
    for (const g of ganchos[cuando]) if (g.tabla === contexto.tabla.id && g.acciones.includes(contexto.accion)) await g.fn(contexto);
  }

  const historial = (q, tabla, registro, accion, cambios) =>
    db.query("INSERT INTO _historial (usuario, tabla, registro, accion, cambios) VALUES ($1, $2, $3, $4, $5)", [
      q.usuario?.id ?? null,
      tabla,
      registro,
      accion,
      cambios,
    ]);

  const conErrores = (fn) => async (q, s) => {
    try {
      await fn(q, s);
    } catch (e) {
      if (e instanceof ErrorDeDatos) return s.status(400).json({ error: e.message });
      throw e;
    }
  };

  app.get("/api/_modelo", requiere(), (q, s) => s.json(modeloPara(modelo, q.usuario)));

  app.get("/api/_resumen", requiere(), async (q, s) => {
    const out = [];
    for (const t of modelo.tablas.filter((t) => puede(q.usuario, t, "leer"))) {
      const dinero = t.campos.filter((c) => c.tipo === "dinero" && c.sumar);
      const sumas = dinero.map((c) => `COALESCE(SUM("${c.id}"), 0) AS "${c.id}"`).join(", ");
      const r = await db.query(`SELECT count(*)::int AS total${sumas ? ", " + sumas : ""} FROM "${t.id}"`);
      out.push({ tabla: t.id, total: r.rows[0].total, sumas: Object.fromEntries(dinero.map((c) => [c.id, r.rows[0][c.id]])) });
    }
    s.json(out);
  });

  app.get("/api/t/:tabla", requiere(), async (q, s) => {
    const t = tablaDe(q, s, "leer");
    if (!t) return;
    const buscables = t.campos.filter((c) => BUSCABLES.has(c.tipo));
    const params = [];
    let donde = "";
    if (q.query.q && buscables.length) {
      params.push(`%${String(q.query.q).slice(0, 100)}%`);
      donde = "WHERE " + buscables.map((c) => `"${c.id}"::text ILIKE $1`).join(" OR ");
    }
    // Filtro exacto por un campo (por ejemplo, los movimientos de un producto): ?campo=valor
    for (const c of t.campos) {
      if (q.query[c.id] === undefined || c.id === "q") continue;
      params.push(String(q.query[c.id]));
      donde += (donde ? " AND " : "WHERE ") + `"${c.id}"::text = $${params.length}`;
    }
    const columnas = new Set(["id", "creado", "actualizado", ...t.campos.map((c) => c.id)]);
    const orden = columnas.has(q.query.orden) ? q.query.orden : t.orden && columnas.has(t.orden) ? t.orden : "id";
    const dir = q.query.dir === "asc" || (!q.query.dir && t.orden_dir === "asc") ? "ASC" : "DESC";
    const limite = Math.min(Math.max(Number(q.query.limite) || 100, 1), 1000);
    const desde = Math.max(Number(q.query.desde) || 0, 0);
    const total = (await db.query(`SELECT count(*)::int AS n FROM "${t.id}" ${donde}`, params)).rows[0].n;
    const filas = (
      await db.query(`SELECT * FROM "${t.id}" ${donde} ORDER BY "${orden}" ${dir} NULLS LAST, id DESC LIMIT ${limite} OFFSET ${desde}`, params)
    ).rows;
    s.json({ filas, total, etiquetas: await etiquetas(t, filas) });
  });

  app.get("/api/t/:tabla/csv", requiere(), async (q, s) => {
    const t = tablaDe(q, s, "leer");
    if (!t) return;
    const filas = (await db.query(`SELECT * FROM "${t.id}" ORDER BY id`)).rows;
    const et = await etiquetas(t, filas);
    const cols = ["id", ...t.campos.map((c) => c.id), "creado"];
    const titulos = ["id", ...t.campos.map((c) => c.nombre), "creado"];
    const lineas = [titulos.map(csvCelda).join(",")];
    for (const f of filas)
      lineas.push(cols.map((c) => csvCelda(et[c]?.[f[c]] ?? (f[c] instanceof Date ? f[c].toISOString() : f[c]))).join(","));
    s.setHeader("Content-Type", "text/csv; charset=utf-8");
    s.setHeader("Content-Disposition", `attachment; filename="${t.id}.csv"`);
    s.send("﻿" + lineas.join("\n"));
  });

  app.get("/api/t/:tabla/:id", requiere(), async (q, s) => {
    const t = tablaDe(q, s, "leer");
    const id = t && idDe(q, s);
    if (!id) return;
    const f = (await db.query(`SELECT * FROM "${t.id}" WHERE id = $1`, [id])).rows[0];
    if (!f) return s.status(404).json({ error: "No existe ese registro" });
    s.json({ fila: f, etiquetas: await etiquetas(t, [f]) });
  });

  app.post(
    "/api/t/:tabla",
    requiere("editor"),
    conErrores(async (q, s) => {
      const t = tablaDe(q, s, "escribir");
      if (!t) return;
      const datos = await datosDe(t, q.body, false);
      await correrGanchos("antes", { tabla: t, accion: "crear", datos, anterior: null, usuario: q.usuario, db });
      const cols = Object.keys(datos);
      const r = await db.query(
        `INSERT INTO "${t.id}" (${[...cols, "creado_por"].map((c) => `"${c}"`).join(", ")})
         VALUES (${[...cols, "creado_por"].map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        [...cols.map((c) => datos[c]), q.usuario.id],
      );
      const fila = r.rows[0];
      await historial(q, t.id, fila.id, "crear", datos);
      await correrGanchos("despues", { tabla: t, accion: "crear", datos, fila, anterior: null, usuario: q.usuario, db });
      s.status(201).json({ fila });
    }),
  );

  app.put(
    "/api/t/:tabla/:id",
    requiere("editor"),
    conErrores(async (q, s) => {
      const t = tablaDe(q, s, "escribir");
      const id = t && idDe(q, s);
      if (!id) return;
      const anterior = (await db.query(`SELECT * FROM "${t.id}" WHERE id = $1`, [id])).rows[0];
      if (!anterior) return s.status(404).json({ error: "No existe ese registro" });
      const datos = await datosDe(t, q.body, true);
      await correrGanchos("antes", { tabla: t, accion: "editar", datos, anterior, usuario: q.usuario, db });
      const cols = Object.keys(datos);
      if (!cols.length) return s.json({ fila: anterior });
      const r = await db.query(
        `UPDATE "${t.id}" SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(", ")}, actualizado = now()
         WHERE id = $${cols.length + 1} RETURNING *`,
        [...cols.map((c) => datos[c]), id],
      );
      const cambios = Object.fromEntries(cols.filter((c) => String(anterior[c]) !== String(datos[c])).map((c) => [c, { antes: anterior[c], ahora: datos[c] }]));
      await historial(q, t.id, id, "editar", cambios);
      await correrGanchos("despues", { tabla: t, accion: "editar", datos, fila: r.rows[0], anterior, usuario: q.usuario, db });
      s.json({ fila: r.rows[0] });
    }),
  );

  app.delete(
    "/api/t/:tabla/:id",
    requiere("editor"),
    conErrores(async (q, s) => {
      const t = tablaDe(q, s, "escribir");
      const id = t && idDe(q, s);
      if (!id) return;
      const anterior = (await db.query(`SELECT * FROM "${t.id}" WHERE id = $1`, [id])).rows[0];
      if (!anterior) return s.status(404).json({ error: "No existe ese registro" });
      // No borrar algo a lo que otros registros todavía apuntan.
      for (const otra of modelo.tablas)
        for (const c of otra.campos.filter((c) => c.tipo === "relacion" && c.tabla === t.id)) {
          const r = await db.query(`SELECT count(*)::int AS n FROM "${otra.id}" WHERE "${c.id}" = $1`, [id]);
          if (r.rows[0].n)
            return s.status(409).json({ error: `No se puede borrar: ${r.rows[0].n} registro(s) de ${otra.nombre} lo usan` });
        }
      await correrGanchos("antes", { tabla: t, accion: "borrar", datos: null, anterior, usuario: q.usuario, db });
      await db.query(`DELETE FROM "${t.id}" WHERE id = $1`, [id]);
      await historial(q, t.id, id, "borrar", anterior);
      await correrGanchos("despues", { tabla: t, accion: "borrar", datos: null, fila: null, anterior, usuario: q.usuario, db });
      s.json({ ok: true });
    }),
  );

  return {
    /** Corre `fn(contexto)` antes de guardar; lanzar ErrorDeDatos cancela el cambio con ese mensaje. */
    antes: (tabla, acciones, fn) => ganchos.antes.push({ tabla, acciones: [].concat(acciones), fn }),
    /** Corre `fn(contexto)` después de guardar (para actualizar otras tablas, mandar avisos, etc.). */
    despues: (tabla, acciones, fn) => ganchos.despues.push({ tabla, acciones: [].concat(acciones), fn }),
    ErrorDeDatos,
  };
}
