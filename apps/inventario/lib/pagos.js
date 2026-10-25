// Cobros con Mercado Pago (opcional: se activa con MERCADOPAGO_ACCESS_TOKEN). Un editor genera un link de
// pago para un registro; cuando se paga, Mercado Pago avisa al webhook, que consulta el pago a la API
// (no confía en el aviso), lo guarda en _pagos y, si la tabla tiene un campo si_no llamado "pagado", lo marca.
const MP = process.env.MERCADOPAGO_API_URL || "https://api.mercadopago.com";

export function rutasPagos(app, db, modelo, { requiere }) {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN || "";
  const moneda = process.env.MONEDA || "MXN";
  const publica = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

  app.get("/api/_pagos/estado", requiere(), (_q, s) => s.json({ activo: !!token, moneda }));

  app.post("/api/_pagos/link", requiere("editor"), async (q, s) => {
    if (!token) return s.status(400).json({ error: "Los cobros no están activados en esta app" });
    const t = modelo.porId[q.body?.tabla];
    const id = Number(q.body?.id);
    const monto = Math.round(Number(q.body?.monto) * 100) / 100;
    if (!t || !Number.isInteger(id) || !(monto > 0)) return s.status(400).json({ error: "Indica el registro y un monto mayor a cero" });
    const fila = (await db.query(`SELECT * FROM "${t.id}" WHERE id = $1`, [id])).rows[0];
    if (!fila) return s.status(404).json({ error: "No existe ese registro" });
    const titulo = String(q.body?.titulo || `${t.singular}: ${fila[t.etiqueta] ?? id}`).slice(0, 120);
    const r = await fetch(`${MP}/checkout/preferences`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ title: titulo, quantity: 1, unit_price: monto, currency_id: moneda }],
        external_reference: `${t.id}:${id}`,
        ...(publica && { notification_url: `${publica}/api/_pagos/webhook` }),
      }),
    });
    if (!r.ok) return s.status(502).json({ error: "Mercado Pago no generó el link. Revisa el token." });
    s.json({ link: (await r.json()).init_point });
  });

  app.post("/api/_pagos/webhook", (q, s) => {
    s.sendStatus(200);
    const idPago = q.body?.data?.id ?? q.query["data.id"];
    if (!token || (q.body?.type ?? q.query.type) !== "payment" || !idPago) return;
    (async () => {
      const r = await fetch(`${MP}/v1/payments/${encodeURIComponent(idPago)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`Mercado Pago respondió ${r.status}`);
      const pago = await r.json();
      const [tabla, registro] = String(pago.external_reference ?? "").split(":");
      const t = modelo.porId[tabla];
      if (!t || !/^\d+$/.test(registro ?? "")) return;
      const nuevo = await db.query(
        "INSERT INTO _pagos (id, tabla, registro, monto, estado) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE SET estado = $5 RETURNING (xmax = 0) AS nuevo",
        [String(pago.id), t.id, Number(registro), pago.transaction_amount ?? null, pago.status],
      );
      if (pago.status === "approved" && t.campos.some((c) => c.id === "pagado" && c.tipo === "si_no")) {
        await db.query(`UPDATE "${t.id}" SET pagado = true, actualizado = now() WHERE id = $1`, [Number(registro)]);
      }
      if (nuevo.rows[0]?.nuevo)
        await db.query("INSERT INTO _historial (tabla, registro, accion, cambios) VALUES ($1, $2, 'pago', $3)", [
          t.id,
          Number(registro),
          { estado: pago.status, monto: pago.transaction_amount },
        ]);
    })().catch((e) => console.error("Error con el aviso de Mercado Pago:", e.message));
  });
}
