#!/usr/bin/env bash
# Revisa desde fuera el servidor de Akamai y deja el resultado como JSON para el tablero de monitoreo.
# Uso:  LINODE_TOKEN=... bash infra/akamai/revisar.sh <ip> <carpeta-de-salida>
# Escribe estado.json (una fila por servicio), servidor.json (el servidor en Akamai) y agrega las filas de
# esta revisión a historial.json (se quedan las últimas 500).
set -euo pipefail
IP=${1:?Falta la IP}
SALIDA=${2:?Falta la carpeta de salida}
mkdir -p "$SALIDA"
BASE=${IP//./-}.sslip.io
AHORA=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# probar <componente> <qué es> <url> [texto esperado]  (sigue redirecciones: cuenta la página final)
probar() {
  local cuerpo codigo seg
  cuerpo=$(mktemp)
  read -r codigo seg < <(curl -sL -o "$cuerpo" -w '%{http_code} %{time_total}\n' --max-time 15 "$3" 2>/dev/null || echo "000 0")
  local estado="En línea"
  if [ "$codigo" = "000" ]; then estado="Sin respuesta"
  elif [ "$codigo" -ge 400 ]; then estado="Error"
  elif [ -n "${4:-}" ] && ! grep -q -- "$4" "$cuerpo"; then estado="Error"; fi
  rm -f "$cuerpo"
  python3 -c 'import json,sys; c,q,u,e,cod,s,t=sys.argv[1:]; print(json.dumps({"componente":c,"que_es":q,"direccion":u,"estado":e,"codigo_http":int(cod),"ms":round(float(s)*1000) if cod!="000" else None,"revisado":t}, ensure_ascii=False))' \
    "$1" "$2" "$3" "$estado" "$codigo" "$seg" "$AHORA"
}

{
  probar "Página" "Sitio de Estilo Internacional" "https://$BASE/" "Estilo Internacional"
  probar "Agenda" "Reservas y panel (barberia-saas)" "https://agenda.$BASE/api/estilo-internacional/info" '"nombre"'
  probar "Base de datos" "PostgreSQL, probada a través de la agenda" "https://agenda.$BASE/api/estilo-internacional/paquetes" '"paquetes"'
  probar "Agente WhatsApp" "Webhook que recibe los mensajes de Meta" "https://whatsapp.$BASE/" "funcionando"
} | python3 -c 'import json,sys; print(json.dumps([json.loads(l) for l in sys.stdin], ensure_ascii=False, indent=1))' > "$SALIDA/estado.json"

# El servidor visto desde la API de Akamai (estado, plan, región).
if [ -n "${LINODE_TOKEN:-}" ]; then
  curl -sS -H "Authorization: Bearer $LINODE_TOKEN" https://api.linode.com/v4/linode/instances \
    | python3 -c '
import json, sys
ip, ahora = sys.argv[1:]
filas = [{"servidor": l["label"], "estado": {"running": "Encendido", "offline": "Apagado", "booting": "Arrancando", "provisioning": "Creándose", "rebooting": "Reiniciando"}.get(l["status"], l["status"]),
          "plan": l["type"], "memoria_mb": l["specs"]["memory"], "region": l["region"], "ip": l["ipv4"][0], "creado": l["created"] + "Z", "revisado": ahora}
         for l in json.load(sys.stdin)["data"] if ip in l["ipv4"]]
print(json.dumps(filas, ensure_ascii=False, indent=1))' "$IP" "$AHORA" > "$SALIDA/servidor.json"
fi

# Historial: las filas de esta revisión al final, hasta 500.
python3 - "$SALIDA" <<'PY'
import json, os, sys
carpeta = sys.argv[1]
ruta = os.path.join(carpeta, "historial.json")
viejas = json.load(open(ruta)) if os.path.exists(ruta) else []
nuevas = [{"revisado": f["revisado"], "componente": f["componente"], "en_linea": f["estado"] == "En línea", "ms": f["ms"]}
          for f in json.load(open(os.path.join(carpeta, "estado.json")))]
json.dump((viejas + nuevas)[-500:], open(ruta, "w"), ensure_ascii=False, indent=1)
PY
echo "Revisión $AHORA guardada en $SALIDA"
