#!/usr/bin/env bash
# Prueba una app antes de publicarla: valida modelo.json, corre sus pruebas contra PostgreSQL y hace un
# recorrido en el navegador (crear cuenta, abrir una sección, agregar un registro) con capturas.
# Uso:  bash apps/_herramientas/probar.sh <id-de-la-app>      (las capturas quedan en $SALIDA)
# Si DATABASE_URL_ADMIN no está, levanta un PostgreSQL de prueba local (necesita root y postgresql instalado).
set -euo pipefail
ID=${1:?Uso: probar.sh <id-de-la-app>}
APPS=$(cd "$(dirname "$0")/.." && pwd)
APP=$APPS/$ID
[ -f "$APP/modelo.json" ] || { echo "No existe $APP/modelo.json"; exit 1; }
SALIDA=${SALIDA:-/tmp/prueba-app-$ID}
mkdir -p "$SALIDA"

if [ -z "${DATABASE_URL_ADMIN:-}" ]; then
  PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$PGBIN" ] || { echo "No hay PostgreSQL: pon DATABASE_URL_ADMIN"; exit 1; }
  D=/var/tmp/apps-pg
  if [ ! -f "$D/data/PG_VERSION" ]; then
    mkdir -p "$D" && chown postgres:postgres "$D"
    su postgres -c "$PGBIN/initdb -D $D/data -E UTF8 --locale=C.UTF-8 -U postgres -A trust" >/dev/null
  fi
  su postgres -c "$PGBIN/pg_ctl -D $D/data status" >/dev/null 2>&1 \
    || su postgres -c "$PGBIN/pg_ctl -D $D/data -o '-p 5434 -k $D' -l $D/log start" >/dev/null
  export DATABASE_URL_ADMIN="postgres://postgres@localhost:5434/postgres?host=$D"
fi

cd "$APP"
echo "▸ Revisando modelo.json"
node -e 'import("./lib/modelo.js").then((m) => { const x = m.cargarModelo("modelo.json"); console.log("  " + x.nombre + ": " + x.tablas.map((t) => t.nombre).join(", ")); })'
[ -d node_modules ] || npm ci --no-audit --no-fund --silent

echo "▸ Pruebas automáticas"
npm test --silent

echo "▸ Recorrido en el navegador"
DB="humo_$(date +%s)_$$"
PUERTO=$((4100 + RANDOM % 800))
URL_DB=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.toString())' "$DATABASE_URL_ADMIN" "$DB")
sql() { node --input-type=module -e 'import pg from "pg"; const c = new pg.Client(process.argv[1]); await c.connect(); await c.query(process.argv[2]); await c.end();' "$DATABASE_URL_ADMIN" "$1"; }
sql "CREATE DATABASE $DB"
PORT=$PUERTO DATABASE_URL=$URL_DB node server.js > "$SALIDA/servidor.log" 2>&1 &
PID=$!
limpiar() { kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true; sql "DROP DATABASE IF EXISTS $DB WITH (FORCE)" || true; }
trap limpiar EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PUERTO/api/_salud" >/dev/null && break; sleep 0.2; done
node "$APPS/_herramientas/recorrido.cjs" "http://127.0.0.1:$PUERTO" "$SALIDA"
echo "✓ $ID pasó todo. Capturas en $SALIDA"
