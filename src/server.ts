import express from "express";
import { config } from "./config.js";
import { responder, type Imagen } from "./agente.js";
import { fechaLocal, sumarDias } from "./fechas.js";
import { cancelar } from "./herramientas.js";
import { agendaDelDia, resumen, type Periodo } from "./insights.js";
import { calendarioActivo, transcribir, transcripcionActiva, turnoDePagoAprobado } from "./integraciones.js";
import * as memoria from "./memoria.js";
import { iniciarTareas } from "./tareas.js";
import {
  avisarAlDueno,
  descargarMedia,
  entregarAvisosPendientes,
  enviarTexto,
  firmaValida,
  marcarLeido,
} from "./whatsapp.js";

const app = express();
app.use(express.json({ verify: (req, _res, buf) => ((req as express.Request & { cuerpoCrudo?: Buffer }).cuerpoCrudo = buf) }));

app.get("/", (_req, res) => {
  res.send("Agente de WhatsApp funcionando ✅");
});

// Meta llama a esta URL una vez para verificar el webhook.
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.whatsapp.verifyToken) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

type MensajeEntrante = {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string };
  audio?: { id: string };
};
type Contacto = { wa_id: string; profile?: { name?: string } };

app.post("/webhook", (req, res) => {
  const cuerpoCrudo = (req as express.Request & { cuerpoCrudo?: Buffer }).cuerpoCrudo;
  if (!cuerpoCrudo || !firmaValida(cuerpoCrudo, req.header("x-hub-signature-256"))) {
    res.sendStatus(401);
    return;
  }
  // Responder rápido: si Meta no recibe 200 en pocos segundos, reintenta el envío.
  res.sendStatus(200);

  for (const entry of req.body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const contactos: Contacto[] = value.contacts ?? [];
      for (const m of (value.messages ?? []) as MensajeEntrante[]) {
        if (!memoria.marcarProcesado(m.id)) continue;
        const nombre = contactos.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        encolar(m.from, () => procesar(m, nombre));
      }
    }
  }
});

// Mercado Pago avisa acá cuando se paga una seña. Se consulta el pago a la API antes de creer nada.
app.post("/mercadopago", (req, res) => {
  res.sendStatus(200);
  const idPago = req.body?.data?.id ?? (req.query["data.id"] as string | undefined);
  const tipo = req.body?.type ?? req.query["type"];
  if (!config.mercadoPago.accessToken || tipo !== "payment" || !idPago) return;

  turnoDePagoAprobado(String(idPago))
    .then(async (id) => {
      const turno = id && memoria.turnoPorId(id);
      if (!turno || turno.pago === "pagado") return;
      memoria.actualizarTurno(turno.id, "pago", "pagado");
      await avisarAlDueno(`💳 Seña pagada del turno #${turno.id}: ${turno.nombre} — ${turno.servicio}, ${turno.inicio.replace("T", " ")}`);
      await enviarTexto(turno.telefono, `¡Recibimos tu seña, ${turno.nombre}! Tu turno del ${turno.inicio.replace("T", " a las ")} quedó asegurado ✅`);
    })
    .catch((e) => console.error("Error procesando el aviso de Mercado Pago:", e));
});

// Los mensajes de un mismo cliente se procesan de a uno, en orden.
const colas = new Map<string, Promise<void>>();
function encolar(telefono: string, tarea: () => Promise<void>) {
  const siguiente = (colas.get(telefono) ?? Promise.resolve())
    .then(tarea)
    .catch((e) => console.error(`Error procesando mensaje de ${telefono}:`, e))
    .finally(() => {
      if (colas.get(telefono) === siguiente) colas.delete(telefono);
    });
  colas.set(telefono, siguiente);
}

/** Saca el texto (y la imagen, si hay) de un mensaje. Los audios se transcriben si está configurado. */
async function leerMensaje(m: MensajeEntrante): Promise<{ texto: string; imagen?: Imagen }> {
  if (m.type === "text") return { texto: m.text?.body ?? "" };
  if (!config.whatsapp.token) return { texto: "" };
  try {
    if (m.type === "image" && m.image) {
      return { texto: m.image.caption ?? "", imagen: await descargarMedia(m.image.id) };
    }
    if (m.type === "audio" && m.audio && transcripcionActiva()) {
      const { datos, tipo } = await descargarMedia(m.audio.id);
      return { texto: `(audio transcripto) ${await transcribir(datos, tipo)}` };
    }
  } catch (e) {
    console.error(`Error leyendo ${m.type} de ${m.from}:`, e);
  }
  return { texto: "" };
}

async function procesar(m: MensajeEntrante, nombre: string | null) {
  const esDueno = !!config.duenoTelefono && m.from === config.duenoTelefono;
  // Cualquier mensaje del dueño abre la ventana de 24 h: se le entrega lo que haya quedado guardado.
  if (esDueno) await entregarAvisosPendientes();

  const { texto, imagen } = await leerMensaje(m);

  if (esDueno && texto.startsWith("/")) {
    await comandoDelDueno(texto);
    return;
  }

  memoria.registrarEvento("mensaje", m.from);

  if (memoria.obtenerModo(m.from) === "humano") {
    const contenido = texto || `[${m.type}]`;
    memoria.agregarNota(m.from, `[Mientras lo atendía una persona del negocio, el cliente escribió: ${contenido}]`);
    await avisarAlDueno(`💬 ${nombre ?? m.from} (+${m.from}): ${contenido}`);
    return;
  }

  if (!texto && !imagen) {
    await enviarTexto(
      m.from,
      m.type === "audio"
        ? "Perdón, no puedo escuchar audios 🙏 ¿Me lo escribís?"
        : "Por ahora solo puedo leer texto y fotos 🙏 ¿Me lo escribís?",
    );
    return;
  }

  console.log(`📩 ${nombre ?? ""} (+${m.from}): ${texto}${imagen ? " [imagen]" : ""}`);
  await marcarLeido(m.id).catch(() => {});
  const respuesta = await responder(m.from, nombre, texto, imagen);
  console.log(`📤 → +${m.from}: ${respuesta}`);
  await enviarTexto(m.from, respuesta);
}

const AYUDA =
  "Comandos:\n" +
  "/responder <número> <mensaje>\n/reactivar <número>\n" +
  "/resumen [hoy|semana|mes]\n/agenda [hoy|mañana|AAAA-MM-DD]\n" +
  "/cancelar <n° de turno> [motivo]\n/cerrar <mañana|AAAA-MM-DD>\n/abrir <mañana|AAAA-MM-DD>";

/** Interpreta "hoy", "mañana" o AAAA-MM-DD. */
function leerDia(texto: string | undefined): string | null {
  const hoy = fechaLocal(new Date());
  if (!texto || texto === "hoy") return hoy;
  if (texto === "mañana" || texto === "manana") return sumarDias(hoy, 1);
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}

async function comandoDelDueno(texto: string) {
  const [comando, argumento, ...resto] = texto.trim().split(/\s+/);

  if (comando === "/responder" && argumento && resto.length) {
    const mensaje = resto.join(" ");
    const r = await enviarTexto(argumento, mensaje);
    if (r.ok) memoria.agregarNota(argumento, `[Persona del negocio le respondió al cliente: ${mensaje}]`);
    else await avisarAlDueno(`No se pudo enviar a +${argumento} (¿pasaron más de 24 h desde su último mensaje?).`);
  } else if (comando === "/reactivar" && argumento) {
    memoria.cambiarModo(argumento, "agente");
    await avisarAlDueno(`🤖 El agente vuelve a atender a +${argumento}.`);
  } else if (comando === "/resumen") {
    const periodo = (["hoy", "semana", "mes"].includes(argumento) ? argumento : "hoy") as Periodo;
    await avisarAlDueno(resumen(periodo));
  } else if (comando === "/agenda") {
    const dia = leerDia(argumento);
    await avisarAlDueno(dia ? agendaDelDia(dia) : AYUDA);
  } else if (comando === "/cancelar" && Number(argumento)) {
    const id = Number(argumento);
    const cliente = memoria.telefonoDeTurno(id);
    const turno = cliente && (await cancelar(id, cliente));
    if (!cliente || !turno) {
      await avisarAlDueno(`No encontré un turno confirmado #${id}.`);
      return;
    }
    const motivo = resto.length ? ` Motivo: ${resto.join(" ")}.` : "";
    const aviso = `Hola ${turno.nombre}, te escribimos porque tuvimos que cancelar tu turno de ${turno.servicio} del ${turno.inicio.replace("T", " a las ")}.${motivo} ¿Querés que te busquemos otro horario?`;
    const r = await enviarTexto(cliente, aviso);
    if (r.ok) memoria.agregarNota(cliente, `[Persona del negocio le escribió al cliente: ${aviso}]`);
    await avisarAlDueno(
      r.ok
        ? `❌ Turno #${id} cancelado y avisado a +${cliente}.`
        : `❌ Turno #${id} cancelado, pero no le pude avisar a +${cliente} (pasaron más de 24 h desde su último mensaje). Llamalo.`,
    );
  } else if ((comando === "/cerrar" || comando === "/abrir") && leerDia(argumento)) {
    const dia = leerDia(argumento)!;
    memoria.cerrarDia(dia, comando === "/cerrar");
    const turnos = memoria.turnosDelDia(dia);
    await avisarAlDueno(
      comando === "/abrir"
        ? `✅ ${dia} vuelve a estar abierto para turnos (según el horario de agenda.json).`
        : `🔒 ${dia} cerrado: el agente no va a dar turnos ese día.` +
            (turnos.length ? `\nOjo, ya hay ${turnos.length} turno(s) ese día; cancelalos con /cancelar:\n${agendaDelDia(dia)}` : ""),
    );
  } else {
    await avisarAlDueno(AYUDA);
  }
}

if (!config.whatsapp.appSecret) {
  console.warn("⚠️  WHATSAPP_APP_SECRET vacío: el webhook acepta pedidos sin verificar la firma de Meta.");
}
console.log(
  `Integraciones: Google Calendar ${calendarioActivo() ? "✅" : "—"} · Mercado Pago ${config.mercadoPago.accessToken ? "✅" : "—"}` +
    ` · Audios ${transcripcionActiva() ? "✅" : "—"} · Recordatorios ${config.whatsapp.plantillaRecordatorio ? "✅" : "—"}`,
);
iniciarTareas();

app.listen(config.port, () => {
  console.log(`Escuchando en http://localhost:${config.port} — webhook en /webhook`);
});
