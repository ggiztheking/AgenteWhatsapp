// Arma la app: base de datos, cuentas, la API de cada sección, cobros y las pantallas. server.js la arranca;
// las pruebas la usan directo.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, join } from "node:path";
import express from "express";
import { cargarModelo } from "./lib/modelo.js";
import { crearDb } from "./lib/db.js";
import { rutasAuth } from "./lib/auth.js";
import { rutasCrud } from "./lib/crud.js";
import { rutasPagos } from "./lib/pagos.js";
import { enviarCorreo } from "./lib/correo.js";

const AQUI = dirname(fileURLToPath(import.meta.url));

export async function crearApp({ databaseUrl = process.env.DATABASE_URL, modeloRuta = join(AQUI, "modelo.json") } = {}) {
  const modelo = cargarModelo(modeloRuta);
  const db = await crearDb(databaseUrl, modelo);
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((_q, s, n) => {
    s.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN" });
    n();
  });
  // Las escrituras solo desde esta misma página (salvo el aviso de Mercado Pago).
  app.use("/api", (q, s, n) => {
    if (["GET", "HEAD"].includes(q.method) || q.path === "/_pagos/webhook") return n();
    const origen = q.get("origin");
    if (origen) {
      try {
        if (new URL(origen).host !== q.get("host")) return s.status(403).json({ error: "Origen no permitido" });
      } catch {
        return s.status(403).json({ error: "Origen no permitido" });
      }
    }
    n();
  });
  app.get("/api/_salud", async (_q, s) => {
    await db.query("SELECT 1");
    s.json({ ok: true, app: modelo.nombre });
  });

  const auth = rutasAuth(app, db, modelo);
  const crud = rutasCrud(app, db, modelo, auth);
  rutasPagos(app, db, modelo, auth);

  // Lo propio de cada app (reglas al guardar, rutas extra) va en personalizado.js.
  const propio = join(AQUI, "personalizado.js");
  if (existsSync(propio)) {
    const mod = await import(pathToFileURL(propio).href);
    await mod.default({ app, db, modelo, requiere: auth.requiere, antes: crud.antes, despues: crud.despues, ErrorDeDatos: crud.ErrorDeDatos, enviarCorreo });
  }

  app.use("/api", (_q, s) => s.status(404).json({ error: "No existe" }));
  app.use(express.static(join(AQUI, "public"), { index: false, maxAge: "5m" }));
  // Cualquier otra dirección sin extensión es una pantalla de la app; un archivo que no existe da 404.
  app.use((q, s, n) => (q.method === "GET" && !extname(q.path) ? s.sendFile(join(AQUI, "public", "index.html")) : n()));
  app.use((e, _q, s, _n) => {
    console.error(e);
    s.status(500).json({ error: "Algo falló en el servidor. Intenta de nuevo." });
  });
  return { app, db, modelo };
}
