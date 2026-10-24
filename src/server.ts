import express from "express";
import { config } from "./config.js";
import { responder } from "./agente.js";
import { fechaLocal, sumarDias } from "./fechas.js";
import { agendaDelDia, iniciarResumenDiario, resumen, type Periodo } from "./insights.js";
import * as memoria from "./memoria.js";
import { avisarAlDueno, enviarTexto, firmaValida, marcarLeido } from "./whatsapp.js";

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

type MensajeEntrante = { id: string; from: string; type: string; text?: { body: string } };
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

async function procesar(m: MensajeEntrante, nombre: string | null) {
  const texto = m.type === "text" ? m.text?.body ?? "" : "";

  if (config.duenoTelefono && m.from === config.duenoTelefono && texto.startsWith("/")) {
    await comandoDelDueno(texto);
    return;
  }

  memoria.registrarEvento("mensaje", m.from);

  if (memoria.obtenerModo(m.from) === "humano") {
    await avisarAlDueno(`💬 ${nombre ?? m.from} (+${m.from}): ${texto || `[${m.type}]`}`);
    return;
  }

  if (!texto) {
    await enviarTexto(m.from, "Por ahora solo puedo leer mensajes de texto 🙏 ¿Me lo escribís?");
    return;
  }

  console.log(`📩 ${nombre ?? ""} (+${m.from}): ${texto}`);
  await marcarLeido(m.id).catch(() => {});
  const respuesta = await responder(m.from, nombre, texto);
  console.log(`📤 → +${m.from}: ${respuesta}`);
  await enviarTexto(m.from, respuesta);
}

async function comandoDelDueno(texto: string) {
  const [comando, telefono, ...resto] = texto.trim().split(/\s+/);
  if (comando === "/responder" && telefono && resto.length) {
    await enviarTexto(telefono, resto.join(" "));
  } else if (comando === "/reactivar" && telefono) {
    memoria.cambiarModo(telefono, "agente");
    await avisarAlDueno(`🤖 El agente vuelve a atender a +${telefono}.`);
  } else if (comando === "/resumen") {
    const periodo = (["hoy", "semana", "mes"].includes(telefono) ? telefono : "hoy") as Periodo;
    await avisarAlDueno(resumen(periodo));
  } else if (comando === "/agenda") {
    // Acá el segundo argumento es el día: hoy, mañana o AAAA-MM-DD.
    const hoy = fechaLocal(new Date());
    const dia = /^\d{4}-\d{2}-\d{2}$/.test(telefono ?? "")
      ? telefono
      : ["mañana", "manana"].includes(telefono ?? "")
        ? sumarDias(hoy, 1)
        : hoy;
    await avisarAlDueno(agendaDelDia(dia));
  } else if (comando === "/cancelar" && Number(telefono)) {
    // Acá el segundo argumento es el número de turno.
    const id = Number(telefono);
    const cliente = memoria.telefonoDeTurno(id);
    const turno = cliente && memoria.cancelarTurno(id, cliente);
    if (!cliente || !turno) {
      await avisarAlDueno(`No encontré un turno confirmado #${id}.`);
      return;
    }
    memoria.registrarEvento("cancelacion", cliente, turno.servicio);
    const motivo = resto.length ? ` Motivo: ${resto.join(" ")}.` : "";
    await enviarTexto(
      cliente,
      `Hola ${turno.nombre}, te escribimos porque tuvimos que cancelar tu turno de ${turno.servicio} del ${turno.inicio.replace("T", " a las ")}.${motivo} ¿Querés que te busquemos otro horario?`,
    );
    await avisarAlDueno(`❌ Turno #${id} cancelado y avisado a +${cliente}.`);
  } else {
    await avisarAlDueno(
      "Comandos:\n/responder <número> <mensaje>\n/reactivar <número>\n" +
        "/resumen [hoy|semana|mes]\n/agenda [hoy|mañana|AAAA-MM-DD]\n/cancelar <n° de turno> [motivo]",
    );
  }
}

if (!config.whatsapp.appSecret) {
  console.warn("⚠️  WHATSAPP_APP_SECRET vacío: el webhook acepta pedidos sin verificar la firma de Meta.");
}
iniciarResumenDiario();

app.listen(config.port, () => {
  console.log(`Escuchando en http://localhost:${config.port} — webhook en /webhook`);
});
