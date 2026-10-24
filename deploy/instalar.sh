#!/usr/bin/env bash
# Instala y levanta el agente en un servidor Ubuntu (Akamai Cloud / Linode). Córrelo como root dentro de la
# carpeta del repositorio, con el .env ya lleno:  bash deploy/instalar.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Falta el archivo .env (cópialo de .env.example y llénalo)."; exit 1; }

if ! command -v docker >/dev/null; then
  echo "Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# Sin dominio propio se usa <ip>.sslip.io, que apunta solo a la IP del servidor y acepta certificado HTTPS.
if ! grep -q '^DOMINIO=.' .env; then
  ip=$(hostname -I | awk '{print $1}')
  sed -i '/^DOMINIO=/d' .env
  echo "DOMINIO=${ip//./-}.sslip.io" >> .env
fi
dominio=$(grep '^DOMINIO=' .env | cut -d= -f2-)

# Firewall: solo SSH y web.
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

mkdir -p data
docker compose up -d --build

echo
echo "Listo. Revisa que responda:  curl https://$dominio/"
echo "En Meta, la URL del webhook es:  https://$dominio/webhook"
echo "Para URL_PUBLICA en .env usa:    https://$dominio"
echo "Logs:  docker compose logs -f agente"
