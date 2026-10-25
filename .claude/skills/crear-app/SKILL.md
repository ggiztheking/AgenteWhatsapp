---
name: crear-app
description: Crea, cambia o publica una app web completa (base de datos, cuentas con roles, historial, exportar CSV, cobros con Mercado Pago, correo) a partir de una descripción en palabras, y la publica sola en el servidor de Akamai con su propia dirección HTTPS. Úsala cuando el usuario pida una app, un sistema, un CRM, un inventario, un registro, un portal, un control de algo, o un cambio a una app que ya existe en apps/.
---

# /crear-app: de una descripción a una app publicada

El flujo es el de Hercules: la persona describe lo que necesita, tú construyes la app completa, la pruebas y la
publicas; después la persona pide cambios por chat y cada cambio se publica solo. Habla siempre en español, en
términos de lo que la persona verá (secciones, campos, botones), nunca de tablas, JSON o contenedores.

## Cómo está armado

- Cada app es una carpeta `apps/<id>/` copiada de `apps/_plantilla/` (Node 22 + Express + PostgreSQL, sin build).
- **`modelo.json` es la app**: sus secciones (`tablas`) y sus campos. De ahí salen solas la base de datos, la API
  y todas las pantallas (menú, inicio con resumen, listas con búsqueda y orden, formularios, registros
  relacionados, usuarios, historial, exportar CSV, link de pago). Casi todo lo que pida la persona se resuelve
  bien en el modelo.
- `personalizado.js`: reglas del negocio al guardar (`antes`, `despues`) y rutas extra de la API.
  `public/personalizado-ui.js`: pantallas o tarjetas extra en el inicio. Úsalos solo para lo que el modelo no cubre.
- Cada app tiene su propia copia de la plantilla: mejorar `apps/_plantilla` no cambia las que ya existen.
- Ya vienen hechos y no se tocan: cuentas (la primera persona que entra es administradora; roles `lector`,
  `editor`, `admin`), historial de cambios, validación, protección contra otros sitios, cobros
  (`MERCADOPAGO_ACCESS_TOKEN`) y correo (`enviarCorreo`, con `RESEND_API_KEY`).
- Publicar = que el commit llegue a la rama **`produccion`** de este repositorio. El servidor revisa GitHub cada
  2 minutos, crea la base de datos de la app, la compila y la sirve en `https://<id>.<dirección principal>`.
  La dirección principal actual está en `infra/akamai/README.md` y en el monitor; hoy es `172-235-141-127.sslip.io`.

## Pasos

1. **Entender.** Si la descripción alcanza para armar algo útil, no preguntes: decide con criterio y di qué
   supusiste. Pregunta (máximo 2 preguntas, con AskUserQuestion) solo lo que cambia la estructura y no se puede
   suponer: por ejemplo, quién la usa (solo el equipo, o también clientes) o qué cosas se registran.
2. **Nombre.** Un `id` corto en minúsculas con guiones (`inventario`, `control-gastos`); será el subdominio.
   Revisa que `apps/<id>` no exista (si existe, es un cambio: ve al paso 6).
3. **Copiar la plantilla:** `cp -r apps/_plantilla apps/<id> && rm -rf apps/<id>/node_modules`.
   Cambia `"name"` en `apps/<id>/package.json` a `app-<id>`.
4. **Diseñar `modelo.json`** (ver la referencia abajo). Piensa como el negocio: qué cosas existen (secciones),
   qué se anota de cada una (campos), cómo se conectan (relaciones), quién ve y quién edita. Pon nombres que la
   persona usaría, `color` acorde a su marca, `defecto` útiles (`"hoy"` en fechas), `orden` lógico.
5. **Reglas del negocio** que el modelo no expresa (descontar existencias al vender, impedir algo, mandar un
   correo, calcular un total) en `personalizado.js` con `antes`/`despues`. Errores para la persona:
   `throw new ErrorDeDatos("mensaje claro")`. Si agregas reglas, agrega su prueba en `apps/<id>/test/`.
6. **Cambios a una app existente:** edita `apps/<id>/modelo.json` (o sus archivos) y nada más. Agregar secciones
   o campos es seguro: la base solo crece y nunca se borran datos. Quitar o renombrar un campo deja la columna
   vieja en la base (no se pierde nada); dilo si pasa. Cambiar el `tipo` de un campo con datos no se aplica a
   la columna existente: crea un campo nuevo.
7. **Probar, siempre, antes de publicar:**
   `bash apps/_herramientas/probar.sh <id>` corre las pruebas genéricas (cada sección: crear, ver, buscar,
   editar, exportar, permisos, historial, borrar) más las tuyas, y un recorrido en el navegador con capturas en
   `/tmp/prueba-app-<id>/` (pon `SALIDA=<tu carpeta temporal>` para guardarlas ahí). Mira las capturas
   `2-inicio.png`, `4-formulario.png` y `6-celular.png` con Read. Corrige y vuelve a probar hasta que pase.
8. **Publicar.** Commit con mensaje claro y push de ese commit a `produccion`
   (`git push origin HEAD:produccion`; si la rama de trabajo de la sesión es otra, sube también a esa). La
   persona lo pidió al usar /crear-app; si en esta sesión no queda claro que quiere publicar, pregunta antes.
   Si el push a `produccion` es rechazado porque avanzó, trae sus cambios (`git fetch origin produccion` y
   merge) y vuelve a probar.
9. **Confirmar que quedó en línea:** espera a que `https://<id>.<dirección principal>/api/_salud` responda 200
   (revisa cada 20 s, hasta 8 minutos; la primera vez tarda más por la compilación y el certificado). Si no
   responde, revisa que la carpeta tenga `modelo.json` válido y que las pruebas pasen; no hay acceso al
   servidor desde aquí.
10. **Entregar** en pocas líneas: la dirección; que la primera persona que entre crea la cuenta de
    administradora (que entre ella primero); qué secciones tiene y qué supusiste; qué reglas agregaste; y una
    o dos ideas de lo siguiente que podría pedir. Si usa cobros o correo y faltan sus claves, di que se ponen
    una sola vez en `/opt/estilo/apps.env` del servidor.

## Referencia de modelo.json

```json
{
  "nombre": "Inventario Estilo Internacional",
  "descripcion": "Productos a la venta y sus movimientos.",
  "color": "#8a5a2b",
  "tablas": [
    {
      "id": "productos", "nombre": "Productos", "singular": "Producto",
      "etiqueta": "nombre", "orden": "nombre", "orden_dir": "asc",
      "permisos": { "leer": ["lector", "editor", "admin"], "escribir": ["editor", "admin"] },
      "campos": [
        { "id": "nombre", "nombre": "Nombre", "tipo": "texto", "requerido": true },
        { "id": "categoria", "nombre": "Categoría", "tipo": "opcion", "opciones": ["Pomada", "Cera"], "requerido": true },
        { "id": "precio", "nombre": "Precio", "tipo": "dinero", "minimo": 0 },
        { "id": "existencias", "nombre": "Existencias", "tipo": "numero", "defecto": 0 },
        { "id": "notas", "nombre": "Notas", "tipo": "texto_largo", "ayuda": "Lo que el equipo debe saber" }
      ]
    },
    {
      "id": "movimientos", "nombre": "Movimientos", "singular": "Movimiento", "etiqueta": "tipo",
      "campos": [
        { "id": "producto", "nombre": "Producto", "tipo": "relacion", "tabla": "productos", "requerido": true },
        { "id": "fecha", "nombre": "Fecha", "tipo": "fecha", "defecto": "hoy", "requerido": true }
      ]
    }
  ]
}
```

- `id` de tablas y campos: minúsculas, números y `_`; no `id`, `creado`, `actualizado`, `creado_por`.
- Tipos: `texto`, `texto_largo`, `numero`, `dinero`, `fecha`, `fecha_hora`, `si_no`, `opcion` (con `opciones`),
  `correo`, `telefono`, `url`, `relacion` (con `tabla`).
- Por campo, opcionales: `requerido`, `defecto` (`"hoy"` en fechas), `minimo` (números), `ayuda`,
  `en_lista: false` (no mostrarlo como columna; la lista muestra hasta 6 columnas), `sumar: true` (en `dinero`:
  muestra el total en la tarjeta del inicio; solo cuando sumar tiene sentido, como ventas o gastos, no precios).
- Por tabla, opcionales: `etiqueta` (el campo que la nombra en listas y relaciones), `orden`/`orden_dir`,
  `descripcion`, `permisos`.
- Un campo `si_no` llamado `pagado` se marca solo cuando Mercado Pago confirma el pago de ese registro.
- Una relación hace que el registro al que apunta muestre su lista de registros relacionados con "Agregar".

## Referencia de personalizado.js

```js
export default function ({ app, db, requiere, antes, despues, ErrorDeDatos, enviarCorreo }) {
  antes("movimientos", ["crear"], async ({ datos, db }) => {
    if (datos.tipo === "Venta") {
      const p = (await db.query("SELECT existencias FROM productos WHERE id = $1", [datos.producto])).rows[0];
      if (p.existencias < datos.cantidad) throw new ErrorDeDatos(`Solo quedan ${p.existencias}`);
    }
  });
  despues("movimientos", ["crear"], async ({ fila, db }) => {
    await db.query("UPDATE productos SET existencias = existencias + $1 WHERE id = $2",
      [fila.tipo === "Venta" ? -fila.cantidad : fila.cantidad, fila.producto]);
  });
  app.get("/api/reporte", requiere("editor"), async (_q, s) => s.json((await db.query("SELECT ...")).rows));
}
```

`antes`/`despues` reciben `{ tabla, accion ("crear" | "editar" | "borrar"), datos, fila, anterior, usuario, db }`.
Usa siempre parámetros (`$1`) en el SQL, nunca valores pegados al texto.
