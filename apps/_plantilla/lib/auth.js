// Cuentas y sesiones: la primera persona que entra crea la cuenta de administrador; después solo un
// administrador agrega gente. Roles: lector (solo ve), editor (ve y edita), admin (todo, más usuarios).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { ROLES } from "./modelo.js";

const DIAS_SESION = 30;
const correoOk = (c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c);
const sha = (t) => createHash("sha256").update(t).digest("hex");
const hashClave = (clave, sal) => scryptSync(clave, sal, 64).toString("hex");
const nivel = (rol) => ROLES.indexOf(rol);

function claveOk(clave, sal, hash) {
  const a = Buffer.from(hashClave(clave, sal), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function leerCookie(q, nombre) {
  for (const parte of (q.headers.cookie ?? "").split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === nombre) return decodeURIComponent(v.join("="));
  }
  return null;
}

// Pocos intentos de entrar por IP: frena a quien prueba contraseñas.
const intentos = new Map();
function demasiados(clave, max = 10, ms = 10 * 60_000) {
  const ahora = Date.now();
  const lista = (intentos.get(clave) ?? []).filter((t) => ahora - t < ms);
  lista.push(ahora);
  intentos.set(clave, lista);
  return lista.length > max;
}

export function rutasAuth(app, db, modelo) {
  const ponerSesion = async (q, s, usuario) => {
    const token = randomBytes(32).toString("hex");
    await db.query("INSERT INTO _sesiones (token, usuario, expira) VALUES ($1, $2, now() + $3::interval)", [
      sha(token),
      usuario,
      `${DIAS_SESION} days`,
    ]);
    s.setHeader(
      "Set-Cookie",
      `sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DIAS_SESION * 86400}${q.secure ? "; Secure" : ""}`,
    );
  };

  // Carga q.usuario en cada pedido a la API.
  app.use("/api", async (q, _s, n) => {
    try {
      const token = leerCookie(q, "sesion");
      if (token) {
        const r = await db.query(
          `SELECT u.id, u.nombre, u.correo, u.rol FROM _sesiones s JOIN _usuarios u ON u.id = s.usuario
           WHERE s.token = $1 AND s.expira > now() AND u.activo`,
          [sha(token)],
        );
        q.usuario = r.rows[0] ?? null;
      }
      n();
    } catch (e) {
      n(e);
    }
  });

  const requiere = (rol = "lector") => (q, s, n) => {
    if (!q.usuario) return s.status(401).json({ error: "Entra con tu cuenta" });
    if (nivel(q.usuario.rol) < nivel(rol)) return s.status(403).json({ error: "Tu cuenta no tiene permiso para esto" });
    n();
  };

  app.get("/api/_estado", async (q, s) => {
    const { rows } = await db.query("SELECT count(*)::int AS n FROM _usuarios");
    s.json({ app: modelo.nombre, color: modelo.color ?? "", configurada: rows[0].n > 0, usuario: q.usuario ?? null });
  });

  app.post("/api/_primer-admin", async (q, s) => {
    if (demasiados("p" + q.ip)) return s.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    const { nombre = "", correo = "", clave = "" } = q.body ?? {};
    if (!String(nombre).trim() || !correoOk(String(correo)) || String(clave).length < 8)
      return s.status(400).json({ error: "Escribe tu nombre, un correo válido y una contraseña de al menos 8 caracteres" });
    const sal = randomBytes(16).toString("hex");
    // Solo si todavía no hay nadie: la inserción y la revisión van juntas para que dos personas no lo logren a la vez.
    const r = await db.query(
      `INSERT INTO _usuarios (nombre, correo, rol, sal, hash)
       SELECT $1, $2, 'admin', $3, $4 WHERE NOT EXISTS (SELECT 1 FROM _usuarios) RETURNING id`,
      [String(nombre).trim().slice(0, 80), String(correo).trim().toLowerCase(), sal, hashClave(String(clave), sal)],
    );
    if (!r.rowCount) return s.status(409).json({ error: "Esta app ya tiene administrador. Entra con tu cuenta." });
    await ponerSesion(q, s, r.rows[0].id);
    s.json({ ok: true });
  });

  app.post("/api/_entrar", async (q, s) => {
    if (demasiados("e" + q.ip)) return s.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    const correo = String(q.body?.correo ?? "").trim().toLowerCase();
    const r = await db.query("SELECT id, sal, hash FROM _usuarios WHERE correo = $1 AND activo", [correo]);
    const u = r.rows[0];
    if (!u || !claveOk(String(q.body?.clave ?? ""), u.sal, u.hash))
      return s.status(401).json({ error: "Correo o contraseña incorrectos" });
    await ponerSesion(q, s, u.id);
    s.json({ ok: true });
  });

  app.post("/api/_salir", async (q, s) => {
    const token = leerCookie(q, "sesion");
    if (token) await db.query("DELETE FROM _sesiones WHERE token = $1", [sha(token)]);
    s.setHeader("Set-Cookie", "sesion=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    s.json({ ok: true });
  });

  app.post("/api/_mi-clave", requiere(), async (q, s) => {
    const { actual = "", nueva = "" } = q.body ?? {};
    const u = (await db.query("SELECT sal, hash FROM _usuarios WHERE id = $1", [q.usuario.id])).rows[0];
    if (!claveOk(String(actual), u.sal, u.hash)) return s.status(400).json({ error: "La contraseña actual no es correcta" });
    if (String(nueva).length < 8) return s.status(400).json({ error: "La nueva contraseña necesita al menos 8 caracteres" });
    const sal = randomBytes(16).toString("hex");
    await db.query("UPDATE _usuarios SET sal = $1, hash = $2 WHERE id = $3", [sal, hashClave(String(nueva), sal), q.usuario.id]);
    s.json({ ok: true });
  });

  // --- Usuarios (solo administradores) ---
  app.get("/api/_usuarios", requiere("admin"), async (_q, s) => {
    const r = await db.query("SELECT id, nombre, correo, rol, activo, creado FROM _usuarios ORDER BY id");
    s.json(r.rows);
  });

  app.post("/api/_usuarios", requiere("admin"), async (q, s) => {
    const { nombre = "", correo = "", rol = "", clave = "" } = q.body ?? {};
    if (!String(nombre).trim() || !correoOk(String(correo)) || !ROLES.includes(rol) || String(clave).length < 8)
      return s.status(400).json({ error: "Escribe nombre, correo válido, rol y una contraseña de al menos 8 caracteres" });
    const sal = randomBytes(16).toString("hex");
    try {
      const r = await db.query(
        "INSERT INTO _usuarios (nombre, correo, rol, sal, hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [String(nombre).trim().slice(0, 80), String(correo).trim().toLowerCase(), rol, sal, hashClave(String(clave), sal)],
      );
      await db.query("INSERT INTO _historial (usuario, tabla, registro, accion, cambios) VALUES ($1, '_usuarios', $2, 'crear', $3)", [
        q.usuario.id,
        r.rows[0].id,
        { nombre, correo, rol },
      ]);
      s.json({ id: r.rows[0].id });
    } catch (e) {
      if (e.code === "23505") return s.status(409).json({ error: "Ya hay una cuenta con ese correo" });
      throw e;
    }
  });

  app.put("/api/_usuarios/:id", requiere("admin"), async (q, s) => {
    const id = Number(q.params.id);
    const actual = (await db.query("SELECT id, rol, activo FROM _usuarios WHERE id = $1", [id])).rows[0];
    if (!actual) return s.status(404).json({ error: "No existe esa cuenta" });
    const rol = q.body?.rol ?? actual.rol;
    const activo = q.body?.activo ?? actual.activo;
    if (!ROLES.includes(rol)) return s.status(400).json({ error: "Rol desconocido" });
    // Nunca dejar la app sin un administrador activo.
    if (actual.rol === "admin" && (rol !== "admin" || !activo)) {
      const { rows } = await db.query("SELECT count(*)::int AS n FROM _usuarios WHERE rol = 'admin' AND activo AND id <> $1", [id]);
      if (!rows[0].n) return s.status(400).json({ error: "Tiene que quedar al menos un administrador activo" });
    }
    await db.query("UPDATE _usuarios SET rol = $1, activo = $2 WHERE id = $3", [rol, !!activo, id]);
    if (!activo) await db.query("DELETE FROM _sesiones WHERE usuario = $1", [id]);
    if (q.body?.clave) {
      if (String(q.body.clave).length < 8) return s.status(400).json({ error: "La contraseña necesita al menos 8 caracteres" });
      const sal = randomBytes(16).toString("hex");
      await db.query("UPDATE _usuarios SET sal = $1, hash = $2 WHERE id = $3", [sal, hashClave(String(q.body.clave), sal), id]);
    }
    await db.query("INSERT INTO _historial (usuario, tabla, registro, accion, cambios) VALUES ($1, '_usuarios', $2, 'editar', $3)", [
      q.usuario.id,
      id,
      { rol, activo: !!activo, clave_cambiada: !!q.body?.clave },
    ]);
    s.json({ ok: true });
  });

  app.get("/api/_historial", requiere("admin"), async (_q, s) => {
    const r = await db.query(
      `SELECT h.id, h.tabla, h.registro, h.accion, h.cambios, h.fecha, u.nombre AS usuario
       FROM _historial h LEFT JOIN _usuarios u ON u.id = h.usuario ORDER BY h.fecha DESC LIMIT 300`,
    );
    s.json(r.rows);
  });

  return { requiere };
}
