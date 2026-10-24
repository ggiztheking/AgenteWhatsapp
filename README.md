# Agente de WhatsApp · Estilo Internacional

Un agente con Claude que atiende el WhatsApp de la barbería: responde dudas, agenda, confirma, cambia y cancela citas **en la misma agenda de la página web** (barberia-saas), rescata los lugares que se liberan con una lista de espera, entiende fotos y audios, puede cobrar un anticipo y pasa la conversación a una persona cuando hace falta. Al dueño le manda avisos y métricas.

## Contra Sofía IA (AgendaPro)

Comparado con lo que AgendaPro anuncia de Sofía IA en su página y su blog.

| | Sofía IA | Este agente |
|---|---|---|
| Recordatorio por WhatsApp desde tu número | ✅ | ✅ con botones *Confirmo / Cambiar / Cancelar* |
| Insiste si el cliente no contesta | ✅ | ✅ una vez, 4 h después, nunca de noche |
| Recordatorio a la hora en que el cliente suele contestar | ✅ | ✅ |
| Cambiar de horario por chat | ✅ | ✅ misma cita, mismo barbero, en la agenda de tu página |
| Lugar liberado al cancelar | Lo reagenda | Avisa al momento a **toda la lista de espera** de ese día; el primero que contesta se lo queda |
| Agendar desde cero por chat (paquete, extras, barbero) | Con Julia, otra IA de AgendaPro | ✅ el mismo agente, y ofrece un extra antes de confirmar |
| Entiende fotos del corte y notas de voz | No lo anuncia | ✅ |
| Métricas por WhatsApp para el dueño | No lo anuncia | ✅ `/resumen`: confirmaciones, citas rescatadas y **cuánto dinero se recuperó** |
| Dónde viven tus datos y tu agenda | En AgendaPro | En tu propia agenda (barberia-saas) y tu servidor |
| Costo | Suscripción de AgendaPro | Solo lo que uses de Claude y WhatsApp |

```
Cliente ──► WhatsApp (Cloud API) ──► Agente (Claude) ──┬─► Agenda      (barberia-saas: barberos, horarios, citas)
                                                       ├─► Negocio     (negocio.md: paquetes, precios, horario)
                                                       ├─► Memoria     (historial, métricas · SQLite)
                                                       └─► Opcionales  (Google Calendar, Mercado Pago, audios)
```

## Estructura

| Archivo | Qué es |
|---|---|
| `negocio.md` | **Lo que sabe el agente**: paquetes, extras, precios, horario, dirección y políticas. |
| `agenda.json` | Agenda local de respaldo (solo se usa si no configuras `BARBERIA_URL`). |
| `src/agente.ts` | El agente: instrucciones, llamada a Claude y ciclo de herramientas. |
| `src/herramientas.ts` | Acciones: `consultar_disponibilidad`, `agendar_cita`, `ver_mis_citas`, `confirmar_cita`, `reprogramar_cita`, `cancelar_cita`, `apuntar_lista_espera`, `tomar_pedido`, `derivar_a_humano`. |
| `src/barberia.ts` | Conexión con la agenda de barberia-saas. |
| `src/memoria.ts` | Base SQLite: conversaciones, copia de las citas, pedidos, métricas y respaldos. |
| `src/insights.ts` | Métricas para el dueño: `/resumen` y `/agenda`. |
| `src/tareas.ts` | Lo que corre solo: recordatorios, resumen diario y respaldo. |
| `src/integraciones.ts` | Google Calendar, Mercado Pago y transcripción de audios (opcionales). |
| `src/whatsapp.ts` | Envío de mensajes y plantillas, descarga de fotos y audios. |
| `docker-compose.yml`, `deploy/` | Servidor propio con HTTPS (Akamai Cloud / Linode). |
| `src/server.ts` | Webhooks de WhatsApp y Mercado Pago, y comandos del dueño. |

## 1. Instalar y probar

Requiere Node.js 22.5 o superior.

```bash
npm install
cp .env.example .env   # y llena ANTHROPIC_API_KEY
npm test               # pruebas automáticas
npm run chat           # platica con el agente en la terminal, sin WhatsApp
```

## 2. Conectar con la agenda de la página (barberia-saas)

Pon en `.env` la dirección donde está publicado barberia-saas en Railway:

```
BARBERIA_URL=https://tu-app.up.railway.app
BARBERIA_SLUG=estilo-internacional
```

Con eso el agente usa los barberos, el horario, los días cerrados, los paquetes y los extras que tengas en tu panel, y reserva ahí mismo. Las citas de WhatsApp aparecen en tu panel junto con las de la página, y nunca se empalman. El precio lo calcula la agenda, igual que en la página. Al arrancar, el servidor muestra qué agenda está usando.

Para probar contra un barberia-saas de prueba (**nunca el de producción**): `BARBERIA_PRUEBA_URL=http://localhost:3000 npm test`.

> barberia-saas acepta hasta 10 reservas por hora desde una misma IP, y todas las del agente salen de la misma. Si alguna vez se llega al límite, el agente le ofrece al cliente pasarlo contigo.

## 3. Conectar WhatsApp (Cloud API de Meta)

1. Entra a [developers.facebook.com](https://developers.facebook.com), crea una app de tipo **Business** y agrégale el producto **WhatsApp**.
2. En *WhatsApp → Configuración de la API* copia el **Phone number ID** a `WHATSAPP_PHONE_NUMBER_ID`. Para el token, crea un **usuario del sistema** en el Business Manager con permiso `whatsapp_business_messaging` y genera un token **permanente** (`WHATSAPP_TOKEN`); el token temporal de la consola vence en 24 h.
3. Inventa un `WHATSAPP_VERIFY_TOKEN` y copia el **App Secret** (*Configuración de la app → Básica*) a `WHATSAPP_APP_SECRET`. Sin él, cualquiera podría mandarle mensajes falsos al webhook.
4. Levanta el servidor (`npm start`) en una URL pública (ver el paso 7; para probar en tu compu: `npx cloudflared tunnel --url http://localhost:3000`).
5. En *WhatsApp → Configuración → Webhook* pon `https://TU-URL/webhook` y el mismo verify token, y suscríbete al campo **messages**.
6. Mándale un mensaje al número desde tu celular.

Los celulares de México llegan como `521…` y el agente les responde como `52…`, que es el formato que pide Meta. No tienes que hacer nada.

### Plantillas (recomendado)

WhatsApp solo deja enviar mensajes libres en las 24 h después del último mensaje de esa persona. Para lo demás hacen falta plantillas aprobadas (*WhatsApp Manager → Plantillas de mensajes*, categoría **Utilidad**, idioma **Español (MEX)**). Suelen aprobarse en minutos.

| Variable | Texto sugerido |
|---|---|
| `WHATSAPP_PLANTILLA_AVISO` | `Tienes novedades del asistente de WhatsApp de Estilo Internacional. Responde este mensaje para verlas.` |
| `WHATSAPP_PLANTILLA_RECORDATORIO` | `Hola {{1}}, te recordamos tu cita de {{2}} el {{3}} en Estilo Internacional. ¿Nos confirmas?` con 3 botones de respuesta rápida: `Confirmo`, `Cambiar horario`, `Cancelar` |
| `WHATSAPP_PLANTILLA_SEGUIMIENTO` | `Hola {{1}}, seguimos esperando tu confirmación para tu cita de {{2}} el {{3}}. ¿Vienes?` con los mismos botones |
| `WHATSAPP_PLANTILLA_LUGAR_LIBRE` | `¡Hola {{1}}! Se liberó un lugar el {{2}} en Estilo Internacional: {{3}}. ¿Te lo apartamos? Responde este mensaje.` |

- **Aviso:** si pasaron más de 24 h desde tu último mensaje, los avisos se guardan y te llegan todos juntos en cuanto respondes.
- **Recordatorio:** cada cliente recibe un recordatorio un día antes, entre 9 a. m. y 9 p. m., a la hora en que suele contestar. Cuando toca un botón, el agente confirma, le ofrece otros horarios o cancela, según lo que elija.
- **Seguimiento:** si no contesta en 4 h, se le insiste una sola vez.
- **Lugar libre:** cuando alguien cancela o cambia su cita, se les avisa a los de la lista de espera de ese día.

El seguimiento y el aviso de lugar libre van por texto normal si el cliente escribió en las últimas 24 h; la plantilla solo hace falta para los demás.

## 4. Tú, el dueño

Pon tu número en `DUENO_TELEFONO` (52 + 10 dígitos). Te llegan avisos de citas nuevas, cancelaciones, pedidos, anticipos pagados y conversaciones que el agente te pasa. Cuando el agente te pasa una conversación deja de responderle a ese cliente, y sus mensajes te llegan a ti. Desde tu WhatsApp, escribiéndole al número de la barbería:

- `/responder 5219991234567 Hola, soy Carlos, te atiendo yo` le contesta al cliente.
- `/reactivar 5219991234567` le regresa la conversación al agente, que ve lo que platicaron mientras tanto.
- `/resumen` (o `/resumen semana`, `/resumen mes`) te manda las métricas: mensajes, clientes nuevos, citas agendadas, confirmadas, cambiadas y canceladas, lista de espera y citas rescatadas (con el dinero recuperado), cuántos buscaron cita y no había lugar, venta estimada, paquetes, barberos y horarios más pedidos, y las preguntas que el agente no supo contestar.
- `/agenda` (o `/agenda mañana`, `/agenda 2026-10-30`) lista las citas que se agendaron por WhatsApp ese día, con ✅ si el cliente ya confirmó y ⏳ si no. La agenda completa sigue en tu panel.
- `/cancelar 12 me enfermé` cancela la cita #12 (también en la agenda de la página) y le avisa al cliente.
- `/cerrar 2026-11-02` (o `/cerrar mañana`) hace que el agente no dé citas ese día; `/abrir 2026-11-02` lo vuelve a abrir. Para la página web, bloquea el día también en tu panel.

Con `RESUMEN_DIARIO_HORA=23:15` te llega solo, todos los días, el resumen del día y las citas de mañana.

## 5. Datos del negocio

`negocio.md` tiene lo que el agente puede contestar. Si algo no está ahí, te pasa la conversación. Cuando cambies precios o paquetes en tu panel, cámbialos también en `negocio.md`: el agente agenda con lo que diga la agenda, pero describe los paquetes con lo que diga ese archivo.

## 6. Integraciones opcionales

Cada una se activa al llenar sus variables en `.env`. Al arrancar, el servidor muestra cuáles están activas. Si una falla, la cita o la conversación siguen igual y el error queda en el log.

- **Fotos**: siempre activas. El cliente puede mandar la foto del corte que quiere y el agente la entiende.
- **Audios** (`OPENAI_API_KEY`): se transcriben y el agente los contesta como texto. Sin la clave, le pide al cliente que escriba.
- **Google Calendar** (`GOOGLE_CALENDAR_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`): cada cita de WhatsApp aparece en tu calendario y se borra si se cancela.
  1. En [console.cloud.google.com](https://console.cloud.google.com) crea un proyecto, habilita **Google Calendar API** y crea una **cuenta de servicio** con una clave JSON.
  2. En Google Calendar, *Configuración del calendario → Compartir con determinadas personas*, agrega el correo de la cuenta de servicio con permiso **Hacer cambios en los eventos**.
  3. `GOOGLE_CALENDAR_ID` es el *ID del calendario* (en la misma pantalla; para el principal es tu correo). En `GOOGLE_SERVICE_ACCOUNT_JSON` pega el JSON de la clave en una sola línea.
- **Anticipo con Mercado Pago** (`MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_SENA_PORCENTAJE`, `URL_PUBLICA`): al agendar, el agente le manda al cliente un link para pagar ese porcentaje del total. Con `URL_PUBLICA`, cuando pagan te avisa a ti y le confirma al cliente. El access token de producción está en *Mercado Pago Developers → Tus integraciones → Credenciales*.

## 7. Publicarlo

Sirve cualquier hosting de Node con **disco persistente** para la carpeta `data/`.

**En Akamai Cloud (Linode)**, en un servidor propio con HTTPS incluido y sin comprar dominio: sigue [`deploy/akamai.md`](deploy/akamai.md). Son unos minutos y un solo comando (`bash deploy/instalar.sh`).

**En Railway**, junto a barberia-saas:

1. En tu proyecto de Railway: *New → GitHub Repo →* este repositorio. Railway detecta el `Dockerfile`.
2. Agrega un **Volume** montado en `/app/data`. Sin él se pierden las conversaciones y métricas en cada deploy.
3. Copia las variables de `.env` en *Variables*. Para `BARBERIA_URL` usa la URL pública de barberia-saas.
4. En *Settings → Networking* genera un dominio. Esa es la URL para el webhook de Meta y para `URL_PUBLICA`.

Cada noche se guarda una copia de la base en `data/respaldos/` (se conservan las últimas 7).

Lista para salir:
- [ ] `BARBERIA_URL` apuntando a tu barberia-saas en Railway
- [ ] Token permanente de WhatsApp y `WHATSAPP_APP_SECRET`
- [ ] Hosting con volumen en `/app/data` y webhook configurado en Meta
- [ ] Plantillas de aviso y recordatorio aprobadas
- [ ] Prueba completa desde tu celular: preguntar, agendar, cancelar y pedir hablar con una persona

## Notas

- Modelo: `CLAUDE_MODELO` en `.env` (por defecto `claude-opus-5-5`; también `claude-sonnet-5-5` o `claude-haiku-5-5`), con esfuerzo `medium`. En Opus y Sonnet usa el *fallback* del servidor (`fallbacks: "default"`): si el modelo rechaza un mensaje, la API lo reintenta con otro modelo automáticamente. Haiku no tiene ese fallback.
- La clave de Claude es de la **API** (console.anthropic.com), que se paga por uso y por separado de la suscripción de claude.ai.
- La memoria de cada cliente se reinicia después de 24 h sin mensajes (las citas y pedidos se quedan guardados).
- La hora es la de Mérida (`TZ=America/Merida`).
