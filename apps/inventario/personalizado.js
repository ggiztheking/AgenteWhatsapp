// Reglas del inventario: cada venta, entrada o ajuste mueve las existencias del producto; una venta no puede
// dejar existencias negativas y calcula su total con el precio del producto.
export default function ({ app, db, requiere, antes, despues, ErrorDeDatos }) {
  const efecto = (m) => (m.tipo === "Venta" ? -Math.abs(m.cantidad) : m.tipo === "Entrada" ? Math.abs(m.cantidad) : m.cantidad);

  antes("movimientos", ["crear", "editar"], async ({ datos, anterior, db }) => {
    const m = { ...(anterior ?? {}), ...datos };
    if (m.tipo !== "Ajuste" && !(m.cantidad > 0)) throw new ErrorDeDatos("La cantidad tiene que ser mayor a cero");
    const p = (await db.query("SELECT nombre, existencias, precio FROM productos WHERE id = $1", [m.producto])).rows[0];
    if (!p) throw new ErrorDeDatos("Ese producto ya no existe");
    // Lo que quedaría: se deshace el movimiento anterior (si se edita) y se aplica el nuevo.
    const queda = (p.existencias ?? 0) - (anterior && anterior.producto === m.producto ? efecto(anterior) : 0) + efecto(m);
    if (queda < 0) throw new ErrorDeDatos(`No alcanza: de ${p.nombre} quedan ${p.existencias ?? 0}`);
    if (m.tipo === "Venta" && (datos.total === null || datos.total === undefined)) datos.total = Math.round(p.precio * m.cantidad * 100) / 100;
  });

  despues("movimientos", ["crear", "editar", "borrar"], async ({ accion, fila, anterior, db }) => {
    if (anterior && accion !== "crear")
      await db.query("UPDATE productos SET existencias = COALESCE(existencias, 0) - $1, actualizado = now() WHERE id = $2", [efecto(anterior), anterior.producto]);
    if (fila)
      await db.query("UPDATE productos SET existencias = COALESCE(existencias, 0) + $1, actualizado = now() WHERE id = $2", [efecto(fila), fila.producto]);
  });

  // Para la tarjeta del inicio: lo que hay que volver a pedir.
  app.get("/api/por-surtir", requiere(), async (_q, s) => {
    const r = await db.query(
      "SELECT id, nombre, existencias, minimo FROM productos WHERE activo AND COALESCE(existencias, 0) <= COALESCE(minimo, 0) ORDER BY existencias, nombre",
    );
    s.json(r.rows);
  });
}
