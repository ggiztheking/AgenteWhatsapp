# Agente de WhatsApp para tu negocio

Un agente con Claude que atiende tu WhatsApp: responde consultas, agenda y cancela turnos, toma pedidos y te deriva la charla cuando hace falta una persona.

```
Cliente ──► WhatsApp (Cloud API) ──► Agente (Claude) ──┬─► Memoria   (historial por cliente, SQLite)
                                                       ├─► Negocio   (negocio.md + agenda.json)
                                                       └─► Acciones  (turnos, pedidos, derivar a humano)
```

## Estructura

| Archivo | Qué es |
|---|---|
| `negocio.md` | **Lo que sabe el agente**: servicios, precios, horarios, políticas. Editalo con tus datos. |
| `agenda.json` | Horarios de atención, duración de cada servicio y días cerrados (para calcular turnos libres). |
| `src/agente.ts` | El agente: prompt, llamada a Claude y bucle de herramientas. |
| `src/herramientas.ts` | Acciones: `consultar_disponibilidad`, `agendar_turno`, `ver_mis_turnos`, `cancelar_turno`, `tomar_pedido`, `derivar_a_humano`. |
| `src/memoria.ts` | Base SQLite: conversaciones, turnos y pedidos. |
| `src/whatsapp.ts` | Envío de mensajes por la Cloud API de Meta. |
| `src/insights.ts` | Métricas para el dueño: `/resumen`, `/agenda` y el resumen diario automático. |
| `src/server.ts` | Servidor del webhook que recibe los mensajes. |
| `src/chat-consola.ts` | Chat de prueba en la terminal, sin WhatsApp. |

## 1. Instalar

Requiere Node.js 22.5 o superior.

```bash
npm install
cp .env.example .env   # y completá ANTHROPIC_API_KEY
```

## 2. Probar sin WhatsApp

```bash
npm run chat
```

Escribí como si fueras un cliente ("hola, ¿tenés turno para corte el sábado?"). Los avisos que recibiría el dueño se muestran en pantalla.

## 3. Conectar WhatsApp (Cloud API de Meta)

1. Entrá a [developers.facebook.com](https://developers.facebook.com), creá una app de tipo **Business** y agregale el producto **WhatsApp**.
2. En *WhatsApp → Configuración de la API* copiá el **Phone number ID** y el **token** a `.env` (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`). Para producción generá un token permanente con un usuario del sistema.
3. Inventá un `WHATSAPP_VERIFY_TOKEN` y copiá el **App Secret** (*Configuración de la app → Básica*) a `WHATSAPP_APP_SECRET`.
4. Levantá el servidor (`npm start`) y exponelo con una URL pública (para probar: `npx cloudflared tunnel --url http://localhost:3000` o ngrok).
5. En *WhatsApp → Configuración → Webhook* poné `https://TU-URL/webhook` y el mismo verify token, y suscribite al campo **messages**.
6. Mandá un mensaje al número desde tu celular.

## 4. Vos, el dueño

Poné tu número en `DUENO_TELEFONO`. Te llegan avisos de turnos nuevos, cancelaciones, pedidos y derivaciones. Cuando el agente deriva una charla deja de responderle a ese cliente, y sus mensajes te llegan a vos. Desde tu WhatsApp, escribiéndole al número del negocio:

- `/responder 5491112345678 Hola, soy Laura, te ayudo yo` le contesta al cliente.
- `/reactivar 5491112345678` devuelve la charla al agente.
- `/resumen` (o `/resumen semana`, `/resumen mes`) te manda las métricas: mensajes, clientes nuevos, turnos agendados y cancelados, pedidos, derivaciones, gente que buscó turno y no había lugar, ocupación de la agenda, facturación estimada, servicios y horarios más pedidos, y las preguntas que el agente no supo responder.
- `/agenda` (o `/agenda mañana`, `/agenda 2026-10-30`) lista los turnos del día.
- `/cancelar 12 me enfermé` cancela el turno #12 y le avisa al cliente.

Con `RESUMEN_DIARIO_HORA=20:00` en `.env` te llega solo, todos los días, el resumen del día y la agenda de mañana. Para la facturación estimada cargá `precios` en `agenda.json`; `anticipacionCancelarHoras` define con cuánta anticipación el cliente puede cancelar solo.

> WhatsApp solo deja enviar mensajes libres dentro de las 24 h posteriores al último mensaje de esa persona. Para recibir los avisos sin cortes, mandale un mensaje al número del negocio cada tanto (o configurá una plantilla aprobada).

## 5. En vivo

Cualquier hosting de Node con disco persistente para `data/agente.db` sirve (Railway, Render, Fly.io, un VPS). Configurá las variables de `.env` y usá `npm start` como comando de inicio.

## Notas

- Modelo: `claude-opus-5-5` con esfuerzo `medium`. Usa el *fallback* del servidor (`fallbacks: "default"`), así que si el modelo rechaza un pedido, la API lo reintenta con otro modelo de forma automática.
- La memoria de cada cliente se reinicia después de 24 h sin mensajes (los turnos y pedidos quedan guardados).
- Solo entiende mensajes de texto. A los audios e imágenes les pide que escriban.
