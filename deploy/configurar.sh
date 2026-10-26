#!/usr/bin/env bash
# Configura el .env preguntando cada clave (sin que se vean en pantalla) y levanta el agente.
# Uso, en el servidor:  bash agente/deploy/configurar.sh
# En el servidor completo de infra/akamai (página + agenda + agente) se llama con ENV_FILE=/opt/estilo/agente.env:
# ahí solo guarda las claves y reinicia el agente.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV=${ENV_FILE:-.env}
[ -f "$ENV" ] || cp .env.example "$ENV"
chmod 600 "$ENV"

# Guarda KEY=valor en el archivo de claves, reemplazando el valor anterior.
guardar() {
  local clave=$1 valor=$2
  grep -v "^${clave}=" "$ENV" > "$ENV.tmp" || true
  printf '%s=%s\n' "$clave" "$valor" >> "$ENV.tmp"
  mv "$ENV.tmp" "$ENV"
  chmod 600 "$ENV"
}

actual() { grep "^$1=" "$ENV" | tail -1 | cut -d= -f2- || true; }

# preguntar CLAVE "explicación" [secreta] — Enter deja el valor que ya tenía.
preguntar() {
  local clave=$1 texto=$2 secreta=${3:-} valor previo
  previo=$(actual "$clave")
  case "$previo" in *...|123456789012345|529991234567|https://tu-app.up.railway.app|un-texto-secreto) previo="" ;; esac
  echo
  echo "▸ $texto"
  if [ -n "$previo" ]; then echo "  (Enter para dejar el que ya está)"; fi
  if [ -n "$secreta" ]; then
    read -r -s -p "  $clave: " valor
    echo
  else
    read -r -p "  $clave: " valor
  fi
  valor=${valor:-$previo}
  guardar "$clave" "$valor"
}

echo "Configuración del agente de WhatsApp de Estilo Internacional"
echo "Las claves no se ven mientras las escribes. Si todavía no tienes alguna, deja Enter y la llenas después."

preguntar ANTHROPIC_API_KEY "Clave de Claude (console.anthropic.com → API Keys, empieza con sk-ant-)" secreta
preguntar CLAUDE_MODELO "Modelo: claude-opus-5-5 (el mejor), claude-sonnet-5-5 (mitad de precio) o claude-haiku-5-5 (el más barato)"
preguntar OXION_API_KEY "O, en vez de la clave de Claude: clave de Oxion AI (oxionai.com → Dashboard → API Keys, empieza con cc_). Si están las dos, se usa Claude" secreta
preguntar WHATSAPP_TOKEN "Token permanente de WhatsApp (Meta Business → Usuarios del sistema)" secreta
preguntar WHATSAPP_PHONE_NUMBER_ID "Phone number ID (Meta → WhatsApp → Configuración de la API)"
preguntar WHATSAPP_APP_SECRET "App Secret (Meta → tu app → Configuración → Básica)" secreta
preguntar DUENO_TELEFONO "Tu celular para los avisos: 52 + 10 dígitos, sin espacios (ej. 529991234567)"
if [ -z "${ENV_FILE:-}" ]; then
  preguntar BARBERIA_URL "Dirección de tu barberia-saas en Railway (ej. https://xxxx.up.railway.app). Enter = agenda local"
fi
preguntar OPENAI_API_KEY "Opcional, para entender audios: clave de OpenAI" secreta
preguntar MERCADOPAGO_ACCESS_TOKEN "Opcional, para cobrar anticipo: access token de Mercado Pago" secreta

# El verify token lo inventamos aquí; hay que pegarlo en Meta.
if [ -z "$(actual WHATSAPP_VERIFY_TOKEN)" ] || [ "$(actual WHATSAPP_VERIFY_TOKEN)" = "un-texto-secreto" ]; then
  guardar WHATSAPP_VERIFY_TOKEN "$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
fi

if [ -n "${ENV_FILE:-}" ]; then
  # Datos legales del SaaS de agenda (salen en /terminos y /privacidad): van en las variables de la agenda.
  echo
  echo "Datos de quien ofrece el SaaS de agenda (aparecen en sus términos y su aviso de privacidad):"
  ENV_AGENTE=$ENV
  ENV=$(dirname "$ENV_FILE")/barberia.env
  touch "$ENV" && chmod 600 "$ENV"
  preguntar SAAS_TITULAR "Nombre completo o razón social del dueño del SaaS (como en tu constancia del SAT)"
  preguntar SAAS_DOMICILIO "Domicilio para avisos legales (calle, número, colonia, Mérida, Yucatán)"
  preguntar SOPORTE_WHATSAPP "WhatsApp de soporte del SaaS, 10 dígitos (Enter = sin soporte por WhatsApp)"
  ENV=$ENV_AGENTE
  # Servidor completo: el agente y la agenda ya están corriendo; se reinician para que tomen los datos nuevos.
  (cd infra/akamai && docker compose up -d agente barberia)
else
  bash deploy/instalar.sh
  if [ -z "$(actual URL_PUBLICA)" ]; then
    guardar URL_PUBLICA "https://$(actual DOMINIO)"
    docker compose up -d >/dev/null
  fi
fi
if [ -n "${ENV_FILE:-}" ]; then
  url="https://$(grep '^WHATSAPP=' infra/akamai/.env | tail -1 | cut -d= -f2-)"
else
  url=$(actual URL_PUBLICA)
fi

echo
echo "════════════════════════════════════════════════════════════"
echo " En Meta → WhatsApp → Configuración → Webhook pon:"
echo "   URL de devolución de llamada:  $url/webhook"
echo "   Token de verificación:         $(actual WHATSAPP_VERIFY_TOKEN)"
echo " y suscríbete al campo  messages"
echo
faltan=""
for c in WHATSAPP_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_APP_SECRET DUENO_TELEFONO; do
  [ -n "$(actual $c)" ] || faltan="$faltan $c"
done
# La IA puede ser Claude u Oxion: basta una de las dos claves.
[ -n "$(actual ANTHROPIC_API_KEY)$(actual OXION_API_KEY)" ] || faltan="$faltan ANTHROPIC_API_KEY(u OXION_API_KEY)"
if [ -n "$faltan" ]; then
  echo " Faltan:$faltan"
  if [ -n "${ENV_FILE:-}" ]; then echo " Cuando las tengas, vuelve a correr:  claves"; else echo " Cuando las tengas:  cd ~/agente && bash deploy/configurar.sh"; fi
else
  echo " Todo configurado. Mándale un WhatsApp al número de la barbería para probar."
fi
echo "════════════════════════════════════════════════════════════"
