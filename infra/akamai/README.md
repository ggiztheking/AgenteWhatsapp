# Servidor completo en Akamai Cloud

Un solo servidor (Linode 2 GB, Miami) con todo Estilo Internacional, con HTTPS automático y sin dominio propio
(usa `<ip>.sslip.io`):

| Dirección | Qué es |
|---|---|
| `https://<ip>.sslip.io` | Manda a la página de Estilo Internacional de la agenda. Con `PAGINA_PRINCIPAL=sitio` en `/opt/estilo/AgenteWhatsapp/infra/akamai/.env` muestra en cambio la página del repositorio `estilo-internacional`, compilada como sitio estático |
| `https://agenda.<ip>.sslip.io/estilo-internacional` | Reservas en línea y panel (`barberia-saas` + PostgreSQL) |
| `https://whatsapp.<ip>.sslip.io/webhook` | El agente de WhatsApp (este repositorio), que reserva en esa misma agenda |
| `https://<app>.<ip>.sslip.io` | Cada app de `apps/` (las que crea `/crear-app`), con su propia base de datos |

- `crear-servidor.sh`: crea el servidor por la API de Akamai (`LINODE_TOKEN`) y deja un archivo con las contraseñas.
- `instalar.sh`: lo corre cloud-init al arrancar; instala Docker, baja los tres repositorios, genera las claves,
  levanta todo y pone el horario y la dirección de la barbería en la agenda. Volver a correrlo actualiza todo.
- En el servidor: `claves` pide las claves del agente (Claude, Meta) y lo reinicia; `cat /root/LEEME.txt` muestra
  las direcciones y comandos; la instalación deja su registro en `/var/log/estilo-instalacion.log`.
- La agenda guarda un respaldo diario en `/opt/estilo/respaldos` (7 días).
- El servidor corre lo que está en la rama `produccion` de este repositorio. `actualizar.sh` corre cada 2 minutos:
  si algún repositorio cambió en GitHub, trae los cambios y vuelve a correr `instalar.sh`.
- `apps.py` arma el servicio, el subdominio y la base de datos (con su propio usuario) de cada app de `apps/`.
