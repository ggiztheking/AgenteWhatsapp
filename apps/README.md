# Apps

Cada carpeta es una app web completa que el servidor de Akamai publica sola en `https://<carpeta>.<dirección principal>`
(hoy `https://<carpeta>.172-235-141-127.sslip.io`). Se crean y se cambian con **`/crear-app`** en Claude Code:
describes lo que necesitas y Claude la arma, la prueba y la publica (ver `.claude/skills/crear-app/SKILL.md`).

| Carpeta | Qué es |
|---|---|
| `_plantilla/` | La base de todas: cuentas con roles, historial, exportar CSV, cobros con Mercado Pago y correo. Una app se describe en su `modelo.json` y de ahí salen la base de datos, la API y las pantallas. |
| `_herramientas/` | `probar.sh <app>`: pruebas automáticas contra PostgreSQL y un recorrido en el navegador con capturas. |
| `inventario/` | Inventario de productos de la barbería: existencias que se mueven solas con cada entrada o venta, aviso de lo que hay que surtir. |

- Publicar = subir los cambios a la rama `produccion`. El servidor revisa GitHub cada 2 minutos, crea la base de
  datos de cada app nueva (con su propio usuario, sin acceso a la de la agenda), la compila y le saca HTTPS.
- La primera persona que entra a una app nueva crea la cuenta de administradora.
- Cobros y correo: las claves se ponen una vez en `/opt/estilo/apps.env` del servidor y las usan todas las apps.
- Mejorar `_plantilla` no cambia las apps que ya existen (cada una tiene su copia); se llevan a mano si se quiere.
- Las bases de las apps se respaldan cada noche junto con la de la agenda.
