#!/usr/bin/env python3
"""Revisa con Meta que el token de WhatsApp sirva antes de dejarlo puesto.

Lo llama deploy/configurar.sh (el comando `claves`) justo después de pedir las claves de Meta.
Lee WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID de las variables de entorno (nunca de la línea
de comandos, para que el token no salga en `ps`) y nunca imprime el token.

Pregunta a la Graph API:
  1. /me                                       → de quién es el token
  2. /{id}/assigned_whatsapp_business_accounts → qué cuentas de WhatsApp Business puede usar
  3. /{waba}/phone_numbers                     → qué números tiene cada cuenta
y avisa si el Phone number ID que se escribió está entre ellos.

Siempre sale con código 0: solo informa, no impide guardar las claves.
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("GRAPH_URL", "https://graph.facebook.com/v23.0").rstrip("/")
TOKEN = os.environ.get("WHATSAPP_TOKEN", "").strip()
NUMERO_ID = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()

# Qué significa cada error de Meta y cómo se arregla.
AYUDA = {
    190: "El token no es válido o caducó. Vuelve a generarlo en business.facebook.com → Usuarios del sistema "
         "→ Generar token (caducidad: Nunca) y cópialo completo.",
    200: "Al token le faltan permisos. Al generarlo marca whatsapp_business_management y "
         "whatsapp_business_messaging.",
    10: "Al token le faltan permisos. Al generarlo marca whatsapp_business_management y "
        "whatsapp_business_messaging.",
    100: "Meta no reconoce lo que se pidió. Revisa que el token sea de un usuario del sistema.",
    803: "Meta no encuentra ese usuario. Revisa que el token sea de un usuario del sistema.",
}


class ErrorMeta(Exception):
    def __init__(self, codigo, mensaje):
        super().__init__(mensaje)
        self.codigo = codigo


def pedir(ruta, **params):
    url = f"{API}/{ruta}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            err = json.load(e).get("error", {})
        except Exception:
            err = {}
        raise ErrorMeta(err.get("code", e.code), err.get("message", f"HTTP {e.code}")) from None


def main():
    print()
    print("▸ Revisando el token con Meta…")
    if not TOKEN:
        print("  Sin token todavía: no hay nada que revisar.")
        return
    try:
        yo = pedir("me", fields="id,name")
        cuentas = pedir(f"{yo['id']}/assigned_whatsapp_business_accounts", fields="id,name", limit=100).get("data", [])
        if not cuentas:
            print("  ✘ El token funciona, pero no tiene asignada ninguna cuenta de WhatsApp Business.")
            print("    Arreglo: business.facebook.com → Configuración → Usuarios del sistema → tu usuario")
            print("    → Asignar activos → Cuentas de WhatsApp → la de la barbería, con control total.")
            return
        encontrado = None
        for c in cuentas:
            print(f"  ✔ Ve la cuenta de WhatsApp «{c.get('name', '?')}» (id {c['id']})")
            try:
                numeros = pedir(f"{c['id']}/phone_numbers", fields="id,display_phone_number,verified_name").get("data", [])
            except ErrorMeta as e:
                print(f"    (no se pudieron leer sus números: {e})")
                continue
            for n in numeros:
                marca = "←" if n.get("id") == NUMERO_ID else " "
                print(f"    {marca} {n.get('display_phone_number', '?')}  «{n.get('verified_name', '')}»  Phone number ID {n.get('id')}")
                if n.get("id") == NUMERO_ID:
                    encontrado = n
        if not NUMERO_ID:
            print("  Falta el Phone number ID: copia el del número de la barbería de la lista de arriba.")
        elif encontrado:
            print(f"  ✔ Todo bien: el token puede mandar desde {encontrado.get('display_phone_number')}.")
        else:
            print(f"  ✘ El Phone number ID que escribiste ({NUMERO_ID}) no está en ninguna de esas cuentas.")
            print("    Arreglo: corre `claves` otra vez y pega el Phone number ID correcto de la lista de arriba.")
    except ErrorMeta as e:
        print(f"  ✘ Meta respondió con error {e.codigo}: {e}")
        print(f"    {AYUDA.get(e.codigo, 'Revisa el token y vuelve a correr claves.')}")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"  (No se pudo hablar con Meta para revisar: {e}. Las claves sí se guardaron.)")


if __name__ == "__main__":
    main()
