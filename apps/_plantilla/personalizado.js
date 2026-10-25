// Lógica propia de esta app (opcional): reglas al guardar y rutas extra de la API.
// Recibe { app, db, modelo, requiere, antes, despues, ErrorDeDatos, enviarCorreo }.
//
// Ejemplos:
//   antes("pedidos", "crear", ({ datos }) => {
//     if (datos.cantidad > 100) throw new ErrorDeDatos("No se pueden pedir más de 100 piezas");
//   });
//   despues("pedidos", "crear", async ({ fila, db }) => {
//     await db.query('UPDATE productos SET existencias = existencias - $1 WHERE id = $2', [fila.cantidad, fila.producto]);
//   });
//   app.get("/api/reporte", requiere("editor"), async (_q, s) => s.json((await db.query("SELECT ...")).rows));
export default function personalizado() {}
