#!/usr/bin/env bash
# Crea en Akamai Cloud (Linode) el servidor completo de Estilo Internacional. Necesita LINODE_TOKEN
# (cloud.linode.com → tu perfil → API Tokens). Al arrancar, cloud-init corre instalar.sh solo (~10 min).
# Uso:  LINODE_TOKEN=... bash infra/akamai/crear-servidor.sh [archivo-de-credenciales]
set -euo pipefail
: "${LINODE_TOKEN:?Falta LINODE_TOKEN}"
CRED=${1:-credenciales-akamai.txt}
REGION=${REGION:-us-mia}
TIPO=${TIPO:-g6-standard-1}   # Linode 2 GB
ETIQUETA=${ETIQUETA:-estilo-internacional}
RAMA=${RAMA_AGENTE:-claude/pensive-hopper-3dfnry}

aleatorio() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
ROOT_PASS="$(aleatorio 24)Aa1!"
ADMIN_PASS=$(aleatorio 16)
SUPER_PASS=$(aleatorio 20)

USER_DATA=$(cat <<SCRIPT
#!/bin/bash
exec >> /var/log/estilo-instalacion.log 2>&1
export ADMIN_PASS='$ADMIN_PASS' SUPER_PASS='$SUPER_PASS' RAMA_AGENTE='$RAMA'
apt-get update -qq && apt-get install -y -qq git
git clone -q --depth 1 -b '$RAMA' https://github.com/ggiztheking/AgenteWhatsapp.git /opt/estilo/AgenteWhatsapp
bash /opt/estilo/AgenteWhatsapp/infra/akamai/instalar.sh
SCRIPT
)

CUERPO=$(python3 - "$REGION" "$TIPO" "$ETIQUETA" "$ROOT_PASS" "$USER_DATA" <<'PY'
import base64, json, sys
region, tipo, etiqueta, root_pass, user_data = sys.argv[1:]
print(json.dumps({
    "region": region, "type": tipo, "image": "linode/ubuntu24.04", "label": etiqueta,
    "root_pass": root_pass, "booted": True, "tags": ["estilo-internacional"],
    "metadata": {"user_data": base64.b64encode(user_data.encode()).decode()},
}))
PY
)
RESP=$(curl -sS -X POST https://api.linode.com/v4/linode/instances \
  -H "Authorization: Bearer $LINODE_TOKEN" -H "Content-Type: application/json" -d "$CUERPO")
IP=$(printf '%s' "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['ipv4'][0]) if 'ipv4' in d else sys.exit('Akamai respondió: ' + json.dumps(d))")
BASE=${IP//./-}.sslip.io

umask 077
cat > "$CRED" <<TXT
Estilo Internacional en Akamai Cloud — guarda este archivo en un lugar seguro y bórralo de aquí.

Servidor:  $ETIQUETA ($REGION, $TIPO)  IP $IP
  Entrar:  ssh root@$IP
  Contraseña de root:  $ROOT_PASS

Página:          https://$BASE
Agenda:          https://agenda.$BASE/estilo-internacional
Panel del dueño: https://agenda.$BASE/estilo-internacional/admin
  Contraseña del panel (ADMIN_PASS):  $ADMIN_PASS
Panel /super (SUPER_PASS):            $SUPER_PASS
Webhook de WhatsApp para Meta:  https://whatsapp.$BASE/webhook
  (el token de verificación está en /root/LEEME.txt del servidor; las claves del agente se ponen con el comando: claves)
TXT
echo "Servidor creado: $IP. Credenciales en $CRED. La instalación tarda unos 10 minutos."
