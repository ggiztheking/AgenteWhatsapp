#!/usr/bin/env bash
# Monta el servidor completo de Estilo Internacional en un Ubuntu 24.04 de Akamai Cloud (Linode).
# Lo corre cloud-init al crear el servidor (ver crear-servidor.sh); también se puede volver a correr a mano
# como root para actualizar todo:  bash /opt/estilo/AgenteWhatsapp/infra/akamai/instalar.sh
# Variables: ADMIN_PASS y SUPER_PASS (solo la primera vez; luego se toman del .env guardado).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

RAIZ=/opt/estilo
RAMA_AGENTE=${RAMA_AGENTE:-claude/pensive-hopper-3dfnry}
AQUI=$RAIZ/AgenteWhatsapp/infra/akamai
mkdir -p "$RAIZ" "$RAIZ/datos-agente" "$RAIZ/respaldos"

# Avance de la instalación: solo los nombres de los pasos, en http://<ip>/progreso.txt mientras dura
# (sin claves ni salida de comandos). Al final Caddy toma el puerto 80 y esta página desaparece.
PROGRESO=/run/estilo-progreso
mkdir -p "$PROGRESO"
paso() { echo "$(date -u +%H:%M:%S) $*" | tee -a "$PROGRESO/progreso.txt"; }
if ! ss -ltn | grep -q ':80 '; then
  (cd "$PROGRESO" && exec python3 -m http.server 80 >/dev/null 2>&1) &
  SERVIDOR_PROGRESO=$!
fi
fallo() { paso "FALLÓ en la línea $1 (registro completo: /var/log/estilo-instalacion.log)"; }
trap 'fallo $LINENO' ERR
paso "Instalando Estilo Internacional"

# --- Paquetes, Docker y memoria de intercambio (la compilación de la página pide más de 2 GB a ratos) ---
# En el primer arranque Ubuntu instala actualizaciones y tiene apt ocupado: se espera hasta 15 min.
APT="apt-get -o DPkg::Lock::Timeout=900 -qq"
paso "Paquetes del sistema"
$APT update
$APT install -y git curl ca-certificates ufw >/dev/null
paso "Docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- Código: los tres repositorios ---
paso "Bajando el código"
# Sin preguntar usuario ni contraseña: un repositorio privado falla en vez de quedarse esperando.
export GIT_TERMINAL_PROMPT=0
traer() { # traer <repo> <rama|"">
  local dir=$RAIZ/$1
  if [ -d "$dir/.git" ]; then
    # Copia solo para correr: se deja igual a GitHub aunque allá se reescriba la historia.
    timeout 300 git -C "$dir" fetch -q --depth 1 origin && git -C "$dir" reset -q --hard FETCH_HEAD
  else
    timeout 300 git clone -q --depth 1 ${2:+-b "$2"} "https://github.com/ggiztheking/$1.git" "$dir"
  fi
}
traer AgenteWhatsapp "$RAMA_AGENTE"
traer barberia-saas ""
# La página es de un repositorio privado: si no se puede bajar, se usa la de la agenda.
traer estilo-internacional "" || paso "La página (repositorio privado) no se pudo bajar: la dirección principal mostrará la página de la agenda"

# --- Direcciones: sin dominio propio se usa <ip>.sslip.io, que apunta solo a esta IP y acepta HTTPS ---
IP=$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -1)
BASE=${DOMINIO:-${IP//./-}.sslip.io}

# --- Claves del servidor (se generan una sola vez y se guardan) ---
ENV=$AQUI/.env
touch "$ENV" && chmod 600 "$ENV"
valor() { grep "^$1=" "$ENV" | tail -1 | cut -d= -f2- || true; }
fijar() { grep -v "^$1=" "$ENV" > "$ENV.tmp" || true; printf '%s=%s\n' "$1" "$2" >> "$ENV.tmp"; mv "$ENV.tmp" "$ENV"; chmod 600 "$ENV"; }
aleatorio() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-24}"; }
[ -n "$(valor POSTGRES_PASSWORD)" ] || fijar POSTGRES_PASSWORD "$(aleatorio 32)"
[ -n "$(valor ADMIN_PASS)" ] || fijar ADMIN_PASS "${ADMIN_PASS:-$(aleatorio 16)}"
[ -n "$(valor SUPER_PASS)" ] || fijar SUPER_PASS "${SUPER_PASS:-$(aleatorio 20)}"
fijar RAIZ "$RAIZ"
fijar SITIO "$BASE"
fijar AGENDA "agenda.$BASE"
fijar WHATSAPP "whatsapp.$BASE"

# Claves del agente: se llenan con el comando `claves`. Empiezan vacías (sin WhatsApp ni Claude no manda nada).
AGENTE_ENV=$RAIZ/agente.env
if [ ! -f "$AGENTE_ENV" ]; then
  cat > "$AGENTE_ENV" <<EOF
ANTHROPIC_API_KEY=
CLAUDE_MODELO=claude-opus-5-5
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=$(aleatorio 24)
DUENO_TELEFONO=
WHATSAPP_PLANTILLA_AVISO=
WHATSAPP_PLANTILLA_RECORDATORIO=
WHATSAPP_PLANTILLA_SEGUIMIENTO=
WHATSAPP_PLANTILLA_LUGAR_LIBRE=
WHATSAPP_IDIOMA_PLANTILLAS=es_MX
RESUMEN_DIARIO_HORA=23:15
OPENAI_API_KEY=
MERCADOPAGO_ACCESS_TOKEN=
MERCADOPAGO_SENA_PORCENTAJE=30
MONEDA=MXN
DB_PATH=data/agente.db
TZ=America/Merida
EOF
fi
chmod 600 "$AGENTE_ENV"

cat > /usr/local/bin/claves <<EOF
#!/usr/bin/env bash
# Pide las claves del agente de WhatsApp (Claude, Meta, etc.) y lo reinicia.
ENV_FILE=$AGENTE_ENV exec bash $RAIZ/AgenteWhatsapp/deploy/configurar.sh
EOF
chmod +x /usr/local/bin/claves

# --- Firewall: solo SSH y web ---
ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw --force enable >/dev/null

# --- Levantar todo ---
cd "$AQUI"
paso "Compilando la agenda y el agente (lo más tardado)"
docker compose build
mkdir -p "$RAIZ/sitio"
if [ -d "$RAIZ/estilo-internacional/app" ]; then
  paso "Compilando la página"
  if docker build -q -f "$AQUI/sitio.Dockerfile" --build-arg "SITIO_URL=https://$BASE" \
       --output "type=local,dest=$RAIZ/sitio.nuevo" "$RAIZ/estilo-internacional" >/dev/null; then
    # Se reemplaza el contenido y no la carpeta: Caddy la tiene montada y seguiría viendo la vieja.
    find "$RAIZ/sitio" -mindepth 1 -delete && cp -a "$RAIZ/sitio.nuevo/." "$RAIZ/sitio/" && rm -rf "$RAIZ/sitio.nuevo"
  else
    rm -rf "$RAIZ/sitio.nuevo"
    paso "La página no compiló: la dirección principal mostrará la página de la agenda"
  fi
fi
[ -n "${SERVIDOR_PROGRESO:-}" ] && kill "$SERVIDOR_PROGRESO" 2>/dev/null && sleep 1
paso "Arrancando"
docker compose up -d

# --- Primera vez: horario y datos reales en la agenda (se pueden cambiar en el panel) ---
paso "Configurando la agenda"
if [ ! -f "$RAIZ/.agenda-configurada" ]; then
  for _ in $(seq 1 60); do
    docker compose exec -T barberia node -e "fetch('http://localhost:3000/api/estilo-internacional/info').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null && break
    sleep 5
  done
  # Citas cada hora de 9:30 a 21:30 (la última termina antes de cerrar a las 11 PM).
  docker compose exec -T postgres psql -q -U barberia barberia <<'SQL'
UPDATE negocios SET hora_ini = 9, abre_min = 30, hora_fin = 21, intervalo = 60,
  direccion = 'Calle 158 diagonal y Calle 135, Fracc. Los Héroes, Mérida, Yucatán',
  maps = 'https://maps.app.goo.gl/NpfSt23Eorm4wgd37',
  whatsapp = '9623295413'
WHERE slug = 'estilo-internacional';
SQL
  touch "$RAIZ/.agenda-configurada"
fi

# --- Actualizaciones automáticas: cada 15 min revisa GitHub y, si algo cambió, vuelve a correr esto ---
echo "*/15 * * * * root bash $AQUI/actualizar.sh" > /etc/cron.d/estilo-actualizar

# --- Respaldo diario de la base de la agenda (se quedan 7 días) ---
cat > /etc/cron.daily/respaldo-estilo <<EOF
#!/bin/sh
cd $AQUI && docker compose exec -T postgres pg_dump -U barberia barberia | gzip > $RAIZ/respaldos/agenda-\$(date +%F).sql.gz
find $RAIZ/respaldos -name 'agenda-*.sql.gz' -mtime +7 -delete
EOF
chmod +x /etc/cron.daily/respaldo-estilo

cat > /root/LEEME.txt <<EOF
Estilo Internacional en Akamai Cloud
  Página:          https://$BASE
  Agenda y panel:  https://agenda.$BASE/estilo-internacional   (panel: /estilo-internacional/admin)
  Webhook Meta:    https://whatsapp.$BASE/webhook
  Token de verificación para Meta: $(grep '^WHATSAPP_VERIFY_TOKEN=' "$AGENTE_ENV" | cut -d= -f2-)

Comandos:
  claves                         pide las claves del agente de WhatsApp y lo reinicia
  cd $AQUI && docker compose ps            ver qué está corriendo
  cd $AQUI && docker compose logs -f agente   ver qué hace el agente
  bash $AQUI/instalar.sh         actualizar todo a mano (solo se hace cada 15 min si algo cambió en GitHub;
                                 registro en /var/log/estilo-actualizaciones.log)
Contraseñas de la agenda: $ENV (ADMIN_PASS = panel del dueño, SUPER_PASS = /super)
Respaldos diarios de la agenda: $RAIZ/respaldos
EOF
paso "Listo"
cat /root/LEEME.txt
