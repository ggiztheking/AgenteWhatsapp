#!/usr/bin/env bash
# Dominio propio de la agenda (DOMINIO_AGENDA en el .env, p. ej. agendabarberias.xyz). Se activa solo cuando el
# dominio ya apunta a este servidor, para que Caddy saque el certificado HTTPS a la primera; mientras tanto la
# agenda sigue en agenda.<ip>.sslip.io. Lo llaman instalar.sh y actualizar.sh (cada 2 minutos).
set -uo pipefail
AQUI=$(cd "$(dirname "$0")" && pwd)
ENV=$AQUI/.env
valor() { grep "^$1=" "$ENV" | tail -1 | cut -d= -f2- || true; }
fijar() { grep -v "^$1=" "$ENV" > "$ENV.tmp" || true; printf '%s=%s\n' "$1" "$2" >> "$ENV.tmp"; mv "$ENV.tmp" "$ENV"; chmod 600 "$ENV"; }

D=$(valor DOMINIO_AGENDA)
RAIZ=$(valor RAIZ)
F=${RAIZ:-/opt/estilo}/caddy-apps/dominio.caddy
IP=${IP_SERVIDOR:-$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1)}
apunta() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | grep -qx "$IP"; }

if [ -z "$D" ] || ! apunta "$D"; then
  # Sin dominio o todavía sin apuntar aquí: no se publica (si ya estaba activo y dejó de apuntar, se conserva).
  exit 0
fi

NUEVO=$(
  printf '# Generado por dominio.sh: %s apunta a este servidor.\n%s {\n\treverse_proxy barberia:3000\n}\n' "$D" "$D"
  if apunta "www.$D"; then printf 'www.%s {\n\tredir https://%s{uri} permanent\n}\n' "$D" "$D"; fi
)
[ -f "$F" ] && [ "$(cat "$F")" = "$NUEVO" ] && [ "$(valor AGENDA_PUBLICA)" = "$D" ] && exit 0

mkdir -p "$(dirname "$F")"
printf '%s\n' "$NUEVO" > "$F"
fijar AGENDA_PUBLICA "$D"
cd "$AQUI" || exit 1
# La agenda y el agente usan la dirección nueva (enlaces, pagos, aviso de privacidad) y Caddy la empieza a servir.
docker compose up -d barberia agente </dev/null >/dev/null 2>&1
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null >/dev/null 2>&1 || true
echo "$(date -u) dominio activo: https://$D"
