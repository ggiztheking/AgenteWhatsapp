#!/usr/bin/env python3
"""Arma lo que el servidor necesita para las apps de la carpeta apps/ (cada carpeta con modelo.json, menos las
que empiezan con _): un servicio de docker compose por app, su subdominio en Caddy y la contraseña de su base.

Uso: python3 apps.py <RAIZ> <BASE>     (BASE: la dirección principal, p. ej. 172-235-141-127.sslip.io)
Escribe RAIZ/apps.compose.yml, RAIZ/caddy-apps/apps.caddy y RAIZ/apps-claves.json (solo la primera vez por app),
crea RAIZ/apps.env si falta, y escribe en la salida una línea "<id> <base_de_datos> <contraseña>" por app.
"""
import json
import os
import re
import secrets
import sys

raiz, base = sys.argv[1], sys.argv[2]
carpeta = os.path.join(raiz, "AgenteWhatsapp", "apps")
ID = re.compile(r"^[a-z][a-z0-9-]{1,30}$")

apps = sorted(
    d for d in os.listdir(carpeta)
    if ID.match(d) and os.path.isfile(os.path.join(carpeta, d, "modelo.json"))
) if os.path.isdir(carpeta) else []

ruta_claves = os.path.join(raiz, "apps-claves.json")
claves = json.load(open(ruta_claves)) if os.path.exists(ruta_claves) else {}
for a in apps:
    claves.setdefault(a, secrets.token_urlsafe(24).replace("-", "a").replace("_", "b"))
with open(os.open(ruta_claves, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
    json.dump(claves, f, indent=1)

# Claves que comparten todas las apps (cobros, correo). Se llenan a mano; vacías, esas funciones se apagan.
ruta_env = os.path.join(raiz, "apps.env")
if not os.path.exists(ruta_env):
    with open(os.open(ruta_env, os.O_WRONLY | os.O_CREAT, 0o600), "w") as f:
        f.write("# Claves para todas las apps. Después de cambiarlas: bash instalar.sh\n"
                "MERCADOPAGO_ACCESS_TOKEN=\nRESEND_API_KEY=\nCORREO_REMITENTE=\nMONEDA=MXN\nTZ=America/Merida\n")

servicios = {}
for a in apps:
    db = "app_" + a.replace("-", "_")
    env_files = [ruta_env]
    propio = os.path.join(raiz, "apps", f"{a}.env")
    if os.path.exists(propio):
        env_files.append(propio)
    servicios[f"app-{a}"] = {
        "build": {"context": os.path.join(carpeta, a)},
        "restart": "unless-stopped",
        "env_file": env_files,
        "environment": {
            "DATABASE_URL": f"postgres://{db}:{claves[a]}@postgres:5432/{db}",
            "PORT": "3000",
            "PUBLIC_URL": f"https://{a}.{base}",
        },
        "depends_on": {"postgres": {"condition": "service_healthy"}},
    }

# JSON es YAML válido: docker compose lo lee tal cual.
with open(os.path.join(raiz, "apps.compose.yml"), "w") as f:
    json.dump({"services": servicios} if servicios else {"services": {}}, f, indent=1)

os.makedirs(os.path.join(raiz, "caddy-apps"), exist_ok=True)
with open(os.path.join(raiz, "caddy-apps", "apps.caddy"), "w") as f:
    f.write("# Generado por apps.py: un subdominio por app.\n")
    for a in apps:
        f.write(f"{a}.{base} {{\n\tencode gzip\n\treverse_proxy app-{a}:3000\n}}\n")

for a in apps:
    print(a, "app_" + a.replace("-", "_"), claves[a])
