<!--
Sync Impact Report
- Versión: (plantilla) → 1.0.0 — primera constitución, sacada de README.md, apps/README.md, infra/akamai/README.md
  y del skill /crear-app; no agrega reglas que no se sigan ya.
- Plantillas revisadas: .specify/templates/plan-template.md (Constitution Check usa estos principios),
  spec-template.md y tasks-template.md sin cambios necesarios.
-->
# Constitución de AgenteWhatsapp (Estilo Internacional)

## Principios

### I. Para el negocio, en español de México
Todo lo que ve una persona (mensajes del agente, avisos al dueño, páginas, comandos del servidor) va en español de
México, tuteando y en términos del negocio (citas, barberos, clientes), nunca de tablas o JSON. El código, los
comentarios y los commits también van en español.

### II. El cliente decide y sabe con quién habla (no negociable)
- La primera respuesta a cada cliente dice que lo atiende un asistente automático con IA y que puede pedir una persona.
- BAJA (y sus variantes) detiene todo mensaje automático; ALTA lo reactiva. Lo automático nunca va a quien pidió BAJA.
- Ningún mensaje automático a clientes fuera de 9:00–21:00 (hora de Mérida).
- Con el número vinculado por QR, lo automático solo va a quien ya escribió, con tope por hora.
- El agente nunca inventa datos del negocio: si no está en `negocio.md` o en la agenda, deriva a una persona.

### III. Una sola agenda
Con `BARBERIA_URL`, las citas viven en barberia-saas: el agente consulta, reserva, cambia y cancela ahí, y el precio
lo calcula la agenda. No se duplica la regla de horarios libres.

### IV. Proveedores intercambiables
La IA (Claude u Oxion) y el WhatsApp (Meta, Sent o QR) se eligen por variables y se pueden cambiar sin perder
conversaciones: el historial se guarda siempre en el formato de Claude. Un proveedor nuevo entra como un módulo más
(`src/oxion.ts`, `src/sent.ts`, `src/whatsapp-web.ts`), sin tocar la lógica del agente.

### V. Probado antes de publicar (no negociable)
Cada cambio trae sus pruebas con `node:test` (servicios externos imitados con servidores locales) y pasa
`npm run typecheck` y `npm test` antes de subirse. Las herramientas del agente se definen con zod `strictObject`.

## Seguridad y datos
- Ninguna clave en el repositorio: van en `.env` o, en el servidor, en `/opt/estilo/agente.env` con el comando
  `claves`. Nunca se piden claves por chat.
- Todo webhook verifica su firma (Meta: App Secret; Sent: `whsec_`); sin secreto, `/sent` rechaza todo.
- Las conversaciones y citas son datos personales de clientes reales (LFPDPPP 2025): no se copian fuera del servidor.

## Flujo de trabajo y publicación
- Publicar = que el commit llegue a la rama `produccion`; el servidor de Akamai la revisa cada 2 minutos y se
  actualiza solo. Se pide aprobación a Gael antes de cada push a `produccion`.
- Las apps de `apps/` se hacen con `/crear-app` y se prueban con `apps/_herramientas/probar.sh`.
- Cambios chicos: directo con pruebas. Funciones grandes o con varias piezas: el flujo de Spec Kit
  (`/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`), revisado contra esta constitución.

## Gobierno
Esta constitución manda sobre las demás prácticas del repo. Cambiarla requiere el visto bueno de Gael, subir la
versión (MAYOR: quitar o contradecir un principio; MENOR: agregar uno; PARCHE: aclarar) y actualizar las plantillas
afectadas. Cada plan (`/speckit-plan`) revisa estos principios en su "Constitution Check".

**Versión**: 1.0.0 | **Ratificada**: 2026-10-28 | **Última modificación**: 2026-10-28
