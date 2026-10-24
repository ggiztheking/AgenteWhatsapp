#!/usr/bin/env bash
# Configura el .env preguntando cada clave (sin que se vean en pantalla) y levanta el agente.
# Uso, en el servidor:  bash agente/deploy/configurar.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || cp .env.example .env
chmod 600 .env

# Guarda KEY=valor en .env, reemplazando el valor anterior.
guardar() {
  local clave=$1 valor=$2
  grep -v "^${clave}=" .env > .env.tmp || true
  printf '%s=%s\n' "$clave" "$valor" >> .env.tmp
  mv .env.tmp .env
  chmod 600 .env
}

actual() { grep "^$1=" .env | tail -1 | cut -d= -f2- || true; }

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
preguntar WHATSAPP_TOKEN "Token permanente de WhatsApp (Meta Business → Usuarios del sistema)" secreta
preguntar WHATSAPP_PHONE_NUMBER_ID "Phone number ID (Meta → WhatsApp → Configuración de la API)"
preguntar WHATSAPP_APP_SECRET "App Secret (Meta → tu app → Configuración → Básica)" secreta
preguntar DUENO_TELEFONO "Tu celular para los avisos: 52 + 10 dígitos, sin espacios (ej. 529991234567)"
preguntar BARBERIA_URL "Dirección de tu barberia-saas en Railway (ej. https://xxxx.up.railway.app). Enter = agenda local"
preguntar OPENAI_API_KEY "Opcional, para entender audios: clave de OpenAI" secreta
preguntar MERCADOPAGO_ACCESS_TOKEN "Opcional, para cobrar anticipo: access token de Mercado Pago" secreta

# El verify token lo inventamos aquí; hay que pegarlo en Meta.
if [ -z "$(actual WHATSAPP_VERIFY_TOKEN)" ] || [ "$(actual WHATSAPP_VERIFY_TOKEN)" = "un-texto-secreto" ]; then
  guardar WHATSAPP_VERIFY_TOKEN "$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
fi

bash deploy/instalar.sh

dominio=$(actual DOMINIO)
if [ -z "$(actual URL_PUBLICA)" ]; then
  guardar URL_PUBLICA "https://$dominio"
  docker compose up -d >/dev/null
fi

echo
echo "════════════════════════════════════════════════════════════"
echo " En Meta → WhatsApp → Configuración → Webhook pon:"
echo "   URL de devolución de llamada:  https://$dominio/webhook"
echo "   Token de verificación:         $(actual WHATSAPP_VERIFY_TOKEN)"
echo " y suscríbete al campo  messages"
echo
faltan=""
for c in ANTHROPIC_API_KEY WHATSAPP_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_APP_SECRET DUENO_TELEFONO; do
  [ -n "$(actual $c)" ] || faltan="$faltan $c"
done
if [ -n "$faltan" ]; then
  echo " Faltan:$faltan"
  echo " Cuando las tengas:  cd ~/agente && bash deploy/configurar.sh"
else
  echo " Todo configurado. Mándale un WhatsApp al número de la barbería para probar."
fi
echo "════════════════════════════════════════════════════════════"
