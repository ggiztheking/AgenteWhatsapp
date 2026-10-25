#!/usr/bin/env bash
# Lo corre cron cada 15 minutos: si alguno de los tres repositorios cambió en GitHub (o uno que era
# privado ya se puede bajar), trae los cambios y vuelve a correr instalar.sh, que recompila lo necesario.
set -uo pipefail
RAIZ=/opt/estilo
REGISTRO=/var/log/estilo-actualizaciones.log
export GIT_TERMINAL_PROMPT=0
exec 9>/run/estilo-actualizar.lock
flock -n 9 || exit 0   # ya hay una actualización corriendo

cambio=""
for r in AgenteWhatsapp barberia-saas estilo-internacional; do
  d=$RAIZ/$r
  if [ ! -d "$d/.git" ]; then
    timeout 60 git ls-remote "https://github.com/ggiztheking/$r.git" >/dev/null 2>&1 && cambio="$cambio $r"
    continue
  fi
  timeout 120 git -C "$d" fetch -q --depth 1 origin || continue
  if [ "$(git -C "$d" rev-parse HEAD)" != "$(git -C "$d" rev-parse FETCH_HEAD)" ]; then
    # Se actualiza aquí, antes de correr instalar.sh, para no cambiar ese archivo mientras corre.
    git -C "$d" reset -q --hard FETCH_HEAD
    cambio="$cambio $r"
  fi
done
[ -z "$cambio" ] && exit 0

echo "== $(date -u) cambió:$cambio" >> "$REGISTRO"
bash "$RAIZ/AgenteWhatsapp/infra/akamai/instalar.sh" >> "$REGISTRO" 2>&1
