# Publicar el agente en Akamai Cloud (Linode)

Un servidor chico alcanza de sobra: el agente usa poca memoria y la base es un archivo SQLite.

1. **Crea el servidor.** En [cloud.linode.com](https://cloud.linode.com): *Create → Linode*.
   - Imagen: **Ubuntu 24.04 LTS**.
   - Región: la más cercana a Mérida que aparezca (por ejemplo, Dallas).
   - Plan: **Shared CPU → Nanode 1 GB** (el más barato) es suficiente.
   - Pon una contraseña de root fuerte o, mejor, tu llave SSH.
   - Revisa en *Billing* hasta cuándo es válido tu crédito: los créditos de promoción suelen vencer.
2. **Entra al servidor** (la IP sale en el panel): `ssh root@TU_IP`
3. **Baja el código y llena el `.env`:**
   ```bash
   git clone https://github.com/ggiztheking/AgenteWhatsapp.git agente
   cd agente
   cp .env.example .env
   nano .env        # llena las claves (ver el README); DOMINIO puede quedar vacío
   ```
   Si el repositorio es privado, GitHub te pedirá un token: créalo en *GitHub → Settings → Developer settings → Personal access tokens* con permiso de solo lectura al repositorio.
4. **Instala y levanta todo:** `bash deploy/instalar.sh`
   Instala Docker, abre solo los puertos 22, 80 y 443, y levanta el agente con Caddy, que saca solo el certificado HTTPS. Sin dominio propio usa `TU-IP.sslip.io` (por ejemplo `203-0-113-10.sslip.io`). Al final te muestra la URL del webhook.
5. **En Meta** pon `https://TU-DOMINIO/webhook` como URL del webhook, y en `.env` pon `URL_PUBLICA=https://TU-DOMINIO` (luego `docker compose up -d` para que tome el cambio).

## Día a día

- Ver lo que pasa: `docker compose logs -f agente`
- Actualizar a la última versión: `git pull && docker compose up -d --build`
- Cambiar una clave: edita `.env` y corre `docker compose up -d`
- Las conversaciones, métricas y respaldos diarios viven en la carpeta `data/` del servidor. Para tener una copia fuera del servidor, activa *Backups* en el panel de Linode.

## Con dominio propio

Crea un registro `A` (por ejemplo `whatsapp.tudominio.com`) que apunte a la IP del servidor, pon `DOMINIO=whatsapp.tudominio.com` en `.env` y corre `docker compose up -d`.
