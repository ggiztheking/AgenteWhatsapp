# Agente de WhatsApp para tu negocio

Un agente con Claude que atiende tu WhatsApp: responde consultas, agenda y cancela turnos, toma pedidos, entiende fotos y audios, cobra la seña y te deriva la charla cuando hace falta una persona. A vos te manda métricas del negocio.

```
Cliente ──► WhatsApp (Cloud API) ──► Agente (Claude) ──┬─► Memoria     (historial, turnos, pedidos, métricas · SQLite)
                                                       ├─► Negocio     (negocio.md + agenda.json)
                                                       ├─► Acciones    (turnos, pedidos, derivar a humano)
                                                       └─► Opcionales  (Google Calendar, Mercado Pago, audios)
```

## Estructura

| Archivo | Qué es |
|---|---|
| `negocio.md` | **Lo que sabe el agente**: servicios, precios, horarios, políticas. Editalo con tus datos. |
| `agenda.json` | Horarios, duración y precio de cada servicio, anticipación para cancelar y días cerrados. |
| `src/agente.ts` | El agente: prompt, llamada a Claude y bucle de herramientas. |
| `src/herramientas.ts` | Acciones: `consultar_disponibilidad`, `agendar_turno`, `ver_mis_turnos`, `cancelar_turno`, `tomar_pedido`, `derivar_a_humano`. |
| `src/memoria.ts` | Base SQLite: conversaciones, turnos, pedidos, eventos y respaldos. |
| `src/insights.ts` | Métricas para el dueño: `/resumen` y `/agenda`. |
| `src/tareas.ts` | Lo que corre solo: recordatorios, resumen diario y respaldo. |
| `src/integraciones.ts` | Google Calendar, Mercado Pago y transcripción de audios (todas opcionales). |
| `src/whatsapp.ts` | Envío de mensajes y plantillas, descarga de fotos y audios. |
| `src/server.ts` | Webhooks de WhatsApp y Mercado Pago, y comandos del dueño. |
| `src/chat-consola.ts` | Chat de prueba en la terminal, sin WhatsApp. |

## 1. Instalar

Requiere Node.js 22.5 o superior.

```bash
npm install
cp .env.example .env   # y completá ANTHROPIC_API_KEY
npm test               # pruebas automáticas, sin red
```

## 2. Cargar tu negocio

- `negocio.md`: todo lo que el agente puede contestar. Si no está acá, deriva a vos.
- `agenda.json`: horarios por día, duración (`servicios`) y precio (`precios`) de cada servicio. Los nombres de servicio tienen que ser iguales en las dos listas. `anticipacionCancelarHoras` es con cuánta anticipación el cliente puede cancelar solo; `diasCerrado` son feriados fijos (`"2026-12-25"`).

## 3. Probar sin WhatsApp

```bash
npm run chat
```

Escribí como si fueras un cliente ("hola, ¿tenés turno para corte el sábado?"). Los avisos que recibiría el dueño se muestran en pantalla.

## 4. Conectar WhatsApp (Cloud API de Meta)

1. Entrá a [developers.facebook.com](https://developers.facebook.com), creá una app de tipo **Business** y agregale el producto **WhatsApp**.
2. En *WhatsApp → Configuración de la API* copiá el **Phone number ID** a `WHATSAPP_PHONE_NUMBER_ID`. Para el token, creá un **usuario del sistema** en el Business Manager con permiso `whatsapp_business_messaging` y generá un token **permanente** (`WHATSAPP_TOKEN`); el token temporal de la consola vence en 24 h.
3. Inventá un `WHATSAPP_VERIFY_TOKEN` y copiá el **App Secret** (*Configuración de la app → Básica*) a `WHATSAPP_APP_SECRET`. Sin él cualquiera podría mandarle mensajes falsos al webhook.
4. Levantá el servidor (`npm start`) y exponelo con una URL pública (para probar: `npx cloudflared tunnel --url http://localhost:3000` o ngrok).
5. En *WhatsApp → Configuración → Webhook* poné `https://TU-URL/webhook` y el mismo verify token, y suscribite al campo **messages**.
6. Mandá un mensaje al número desde tu celular.

### Plantillas (recomendado)

WhatsApp solo deja mandar mensajes libres dentro de las 24 h posteriores al último mensaje de esa persona. Para lo demás hacen falta plantillas aprobadas (*WhatsApp Manager → Plantillas de mensajes*, categoría **Utilidad**, idioma Español (ARG)). Suelen aprobarse en minutos.

| Variable | Texto sugerido |
|---|---|
| `WHATSAPP_PLANTILLA_AVISO` | `Tenés novedades del agente de WhatsApp. Respondé este mensaje para verlas.` |
| `WHATSAPP_PLANTILLA_RECORDATORIO` | `Hola {{1}}, te recordamos tu turno de {{2}} el {{3}}. Si no podés venir, avisanos por acá.` |

Con la de aviso, si pasaron más de 24 h desde tu último mensaje, los avisos quedan guardados y te llegan todos juntos apenas respondés. Con la de recordatorio, cada cliente recibe un aviso el día anterior a su turno (baja mucho los que no vienen).

## 5. Vos, el dueño

Poné tu número en `DUENO_TELEFONO`. Te llegan avisos de turnos nuevos, cancelaciones, pedidos, señas pagadas y derivaciones. Cuando el agente deriva una charla deja de responderle a ese cliente, y sus mensajes te llegan a vos. Desde tu WhatsApp, escribiéndole al número del negocio:

- `/responder 5491112345678 Hola, soy Laura, te ayudo yo` le contesta al cliente.
- `/reactivar 5491112345678` devuelve la charla al agente. El agente ve lo que hablaron mientras tanto.
- `/resumen` (o `/resumen semana`, `/resumen mes`) te manda las métricas: mensajes, clientes nuevos, turnos agendados y cancelados, pedidos, derivaciones, gente que buscó turno y no había lugar, ocupación de la agenda, facturación estimada, servicios y horarios más pedidos, y las preguntas que el agente no supo responder.
- `/agenda` (o `/agenda mañana`, `/agenda 2026-10-30`) lista los turnos del día.
- `/cancelar 12 me enfermé` cancela el turno #12 y le avisa al cliente.
- `/cerrar 2026-11-02` (o `/cerrar mañana`) no da más turnos ese día; `/abrir 2026-11-02` lo vuelve a abrir.

Con `RESUMEN_DIARIO_HORA=20:00` te llega solo, todos los días, el resumen del día y la agenda de mañana.

## 6. Integraciones opcionales

Cada una se activa al completar sus variables en `.env`. Al arrancar, el servidor muestra cuáles están activas. Si una falla, el turno o la charla siguen igual y el error queda en el log.

- **Fotos**: siempre activas. El cliente puede mandar la foto del corte que quiere y el agente la entiende.
- **Audios** (`OPENAI_API_KEY`): se transcriben y el agente los responde como texto. Sin la clave, le pide al cliente que escriba.
- **Google Calendar** (`GOOGLE_CALENDAR_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`): cada turno aparece en tu calendario y se borra si se cancela.
  1. En [console.cloud.google.com](https://console.cloud.google.com) creá un proyecto, habilitá **Google Calendar API** y creá una **cuenta de servicio** con una clave JSON.
  2. En Google Calendar, *Configuración del calendario → Compartir con personas*, agregá el email de la cuenta de servicio con permiso **Hacer cambios en eventos**.
  3. `GOOGLE_CALENDAR_ID` es el *ID del calendario* (en la misma pantalla; para el principal es tu email). En `GOOGLE_SERVICE_ACCOUNT_JSON` pegá el JSON de la clave en una sola línea.
- **Seña con Mercado Pago** (`MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_SENA_PORCENTAJE`, `URL_PUBLICA`): al agendar, el agente le pasa al cliente un link de pago por el porcentaje del precio del servicio. Con `URL_PUBLICA` configurada, cuando pagan te avisa a vos y le confirma al cliente. El access token de producción está en *Mercado Pago Developers → Tus integraciones → Credenciales*.

## 7. En vivo

Cualquier hosting de Node con **disco persistente** para la carpeta `data/` sirve (Railway, Render, Fly.io, un VPS). Sin disco persistente se pierden los turnos en cada deploy. Hay un `Dockerfile` listo: montá un volumen en `/app/data`, configurá las variables de `.env` y listo. Cada noche se guarda una copia de la base en `data/respaldos/` (quedan las últimas 7).

Checklist para salir:
- [ ] `negocio.md` y `agenda.json` con tus datos reales
- [ ] Token permanente de WhatsApp y `WHATSAPP_APP_SECRET`
- [ ] Hosting con disco persistente y webhook configurado en Meta
- [ ] Plantillas de aviso y recordatorio aprobadas
- [ ] Prueba completa desde tu celular: consultar, agendar, cancelar, pedir, hablar con una persona

## Notas

- Modelo: `claude-opus-5-5` con esfuerzo `medium`. Usa el *fallback* del servidor (`fallbacks: "default"`), así que si el modelo rechaza un pedido, la API lo reintenta con otro modelo de forma automática.
- La memoria de cada cliente se reinicia después de 24 h sin mensajes (los turnos y pedidos quedan guardados).
