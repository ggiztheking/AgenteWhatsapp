#!/usr/bin/env bash
# Pasa la agenda de Railway a este servidor: copia su base de datos (negocios, citas, clientes, fotos...) en lugar de
# la de aquí y, si quieres, sus variables (Mercado Pago, correo, etc.). Antes respalda la base de aquí.
# Uso, en el servidor:  migrar-railway
#                        migrar-railway --deshacer <respaldo .dump>   (regresa la agenda a ese respaldo)
# La dirección de la base de Railway se pega aquí (no se ve en pantalla ni queda guardada).
set -euo pipefail
AQUI=$(cd "$(dirname "$0")" && pwd)
cd "$AQUI"
ENV=$AQUI/.env
valor() { grep "^$1=" "$ENV" | tail -1 | cut -d= -f2- || true; }
RAIZ=$(valor RAIZ)
RAIZ=${RAIZ:-/opt/estilo}
RESPALDOS=$RAIZ/respaldos
BARBERIA_ENV=$RAIZ/barberia.env
CUANDO=$(date +%F-%H%M)
mkdir -p "$RESPALDOS"
touch "$BARBERIA_ENV" && chmod 600 "$BARBERIA_ENV"

# Cuántos registros hay en las tablas principales, para comparar antes y después.
CONTEO="SELECT string_agg(t || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', t), false, true, '')))[1]::text, ' ' ORDER BY t)
  FROM unnest(ARRAY['negocios','usuarios','citas','cuentas','estilos','extras','imagenes']) AS t WHERE to_regclass(t) IS NOT NULL"
# Ningún comando de docker debe leer la terminal (se comería lo que escribe la persona): todos van con </dev/null,
# salvo el que recibe la base por la tubería.
psql_aqui() { docker compose exec -T postgres psql -U barberia "$@" </dev/null; }
dc() { docker compose "$@" </dev/null >/dev/null 2>&1; }
base_nueva() {
  dc stop barberia agente
  psql_aqui -d postgres -q -c "DROP DATABASE barberia WITH (FORCE)"
  psql_aqui -d postgres -q -c "CREATE DATABASE barberia OWNER barberia"
  psql_aqui -d postgres -q -c "REVOKE CONNECT ON DATABASE barberia FROM PUBLIC"
}
arrancar() {
  dc up -d barberia agente
  for _ in $(seq 1 60); do
    dc exec -T barberia node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" && return 0
    sleep 2
  done
  echo "⚠️  La agenda no respondió en 2 minutos: revisa con  cd $AQUI && docker compose logs barberia"
}

if [ "${1:-}" = "--deshacer" ]; then
  F=${2:?Uso: migrar-railway --deshacer <respaldo .dump>}
  [ -s "$F" ] || { echo "No existe $F"; exit 1; }
  read -r -p "Esto reemplaza la agenda de este servidor por $F. Escribe SI para seguir: " OK
  [ "$OK" = "SI" ] || exit 0
  base_nueva
  docker compose exec -T postgres pg_restore -U barberia -d barberia --no-owner --no-acl < "$F" 2>/dev/null || true
  arrancar
  echo "✓ Agenda regresada a $F · $(psql_aqui -d barberia -tAc "$CONTEO" | tr -d '\r')"
  exit 0
fi

echo "Pasar la agenda de Railway a este servidor"
echo
echo "En Railway: abre tu proyecto → el servicio de PostgreSQL → Variables, y copia DATABASE_PUBLIC_URL"
echo "(empieza con postgresql:// y termina en .proxy.rlwy.net:<número>/railway)."
read -r -s -p "Pégala aquí (no se ve) y presiona Enter: " ORIGEN
echo
case "$ORIGEN" in postgres://* | postgresql://*) ;; *) echo "Eso no parece la dirección de una base PostgreSQL."; exit 1 ;; esac
export ORIGEN

# pg_dump debe ser de la misma versión que el servidor de Railway (o más nuevo).
echo "▸ Revisando la base de Railway"
VER=$(docker run --rm -e ORIGEN postgres:16-alpine </dev/null sh -c 'psql "$ORIGEN" -tAc "SHOW server_version_num"' | tr -d '[:space:]') \
  || { echo "No pude conectarme a la base de Railway. Revisa la dirección (que sea la PUBLIC, no la interna)."; exit 1; }
MAYOR=$((VER / 10000))
if [ "$MAYOR" -lt 16 ]; then MAYOR=16; fi
IMG=mirror.gcr.io/library/postgres:$MAYOR-alpine
ANTES=$(docker run --rm -e ORIGEN -e CONTEO="$CONTEO" postgres:16-alpine </dev/null sh -c 'psql "$ORIGEN" -tAc "$CONTEO"')
echo "  PostgreSQL $MAYOR · $ANTES"
case "$ANTES" in *negocios=*) ;; *) echo "Esa base no tiene la agenda (no encontré la tabla negocios)."; exit 1 ;; esac

echo "▸ Copiando la base de Railway"
docker run --rm -e ORIGEN -v "$RESPALDOS:/r" "$IMG" </dev/null sh -c "pg_dump \"\$ORIGEN\" -Fc --no-owner --no-acl -f /r/railway-$CUANDO.dump"
echo "  Copia guardada en $RESPALDOS/railway-$CUANDO.dump"

echo
echo "Ahora se reemplaza la agenda de este servidor por la de Railway. La de aquí se respalda antes."
read -r -p "Escribe SI para seguir: " OK
[ "$OK" = "SI" ] || { echo "No se cambió nada. La copia de Railway quedó en $RESPALDOS."; exit 0; }

echo "▸ Respaldando la agenda de este servidor"
docker compose exec -T postgres pg_dump -U barberia -Fc barberia </dev/null > "$RESPALDOS/akamai-antes-de-railway-$CUANDO.dump"
echo "  $RESPALDOS/akamai-antes-de-railway-$CUANDO.dump"

echo "▸ Reemplazando la base (la agenda y el agente se detienen un momento)"
base_nueva
# pg_restore de la versión de Railway lo convierte a SQL y lo carga el PostgreSQL de aquí. Algún SET de una versión
# más nueva puede dar error sin importar: lo que cuenta es el conteo de abajo.
docker run --rm -i "$IMG" pg_restore --no-owner --no-acl -f - < "$RESPALDOS/railway-$CUANDO.dump" \
  | docker compose exec -T postgres psql -U barberia -d barberia -q -v ON_ERROR_STOP=0 > /dev/null 2> "$RESPALDOS/restaurar-$CUANDO.log" || true
DESPUES=$(psql_aqui -d barberia -tAc "$CONTEO" | tr -d '\r')

echo "▸ Arrancando la agenda"
arrancar

echo
echo "  En Railway:  $ANTES"
echo "  Aquí ahora:  $DESPUES"
if [ "$ANTES" = "$DESPUES" ]; then
  echo "✓ Se copió todo."
else
  echo "⚠️  Los números no coinciden. Revisa $RESPALDOS/restaurar-$CUANDO.log y no borres Railway todavía."
  echo "   Para regresar a como estaba: migrar-railway --deshacer $RESPALDOS/akamai-antes-de-railway-$CUANDO.dump"
fi

echo
echo "Variables de Railway (Mercado Pago, Stripe, correo de Resend, precios...)."
echo "En Railway: el servicio de la agenda → Variables → Raw Editor → copia todo."
read -r -p "¿Las copias también? (s/n): " SN
if [ "$SN" = "s" ] || [ "$SN" = "S" ]; then
  echo "Pégalas (no se ven) y al terminar presiona Enter y luego Ctrl-D:"
  stty -echo 2>/dev/null || true
  PEGADO=$(cat)
  stty echo 2>/dev/null || true
  # Lo que depende de este servidor no se copia: base, puerto, dirección pública y contraseñas del panel.
  n=0
  while IFS= read -r linea; do
    linea=${linea%$'\r'}
    [[ $linea =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    clave=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
    case "$clave" in DATABASE_URL | DATABASE_PUBLIC_URL | PORT | PUBLIC_URL | ADMIN_PASS | SUPER_PASS | RAILWAY_* | NIXPACKS_* | PG*) continue ;; esac
    v=${v#\"} v=${v%\"}
    grep -v "^$clave=" "$BARBERIA_ENV" > "$BARBERIA_ENV.tmp" || true
    printf '%s=%s\n' "$clave" "$v" >> "$BARBERIA_ENV.tmp"
    mv "$BARBERIA_ENV.tmp" "$BARBERIA_ENV"
    n=$((n + 1))
  done <<< "$PEGADO"
  chmod 600 "$BARBERIA_ENV"
  dc up -d barberia
  echo "✓ $n variables copiadas a $BARBERIA_ENV y la agenda reiniciada."
fi

PUBLICA=$(valor AGENDA_PUBLICA)
echo
echo "Revisa que todo se vea bien en https://${PUBLICA:-$(valor AGENDA)}/estilo-internacional (y en tu panel)."
echo "Cuando estés conforme, ya puedes borrar el proyecto en Railway."
