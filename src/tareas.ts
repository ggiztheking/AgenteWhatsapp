// Tareas que corren solas mientras el servidor está prendido.
import { config } from "./config.js";
import { aFecha, diaDeLaSemana, fechaHoraLocal, sumarDias } from "./fechas.js";
import { agendaDelDia, resumen } from "./insights.js";
import * as memoria from "./memoria.js";
import { avisarAlDueno, enviarPlantilla, escribirAlCliente } from "./whatsapp.js";

// Nunca se le escribe a un cliente de noche.
const HORARIO_DE_ENVIO = { desde: 9, hasta: 21 };
const horasHasta = (inicio: string, ahora: Date) => (aFecha(inicio).getTime() - ahora.getTime()) / 3600_000;
const cuando = (inicio: string) => {
  const [fecha, hora] = inicio.split("T");
  const [, mes, dia] = fecha.split("-");
  return `${diaDeLaSemana(fecha)} ${dia}/${mes} a las ${hora}`;
};

/**
 * Recordatorio con confirmación a los clientes con cita en las próximas ~24 h. Se manda en horario de día y,
 * si el cliente suele escribir a cierta hora, se espera a esa hora (contesta más rápido).
 */
export async function enviarRecordatorios(ahora = new Date()) {
  const plantilla = config.whatsapp.plantillaRecordatorio;
  const hora = ahora.getHours();
  if (!plantilla || hora < HORARIO_DE_ENVIO.desde || hora >= HORARIO_DE_ENVIO.hasta) return;

  const en = (h: number) => fechaHoraLocal(new Date(ahora.getTime() + h * 3600_000));
  for (const t of memoria.turnosParaRecordar(en(2), en(26))) {
    const habitual = memoria.horaHabitual(t.telefono);
    if (habitual !== null && hora < habitual && horasHasta(t.inicio, ahora) > 14) continue;

    // Se marca antes de enviar para no repetirlo si el envío falla una y otra vez.
    memoria.actualizarTurno(t.id, "recordado", 1);
    memoria.actualizarTurno(t.id, "recordado_en", fechaHoraLocal(ahora));
    const r = await enviarPlantilla(t.telefono, plantilla, [t.nombre, t.servicio, cuando(t.inicio)]);
    if (r.ok) {
      memoria.agregarNota(
        t.telefono,
        `[Recordatorio automático enviado de la cita #${t.id}: ${t.servicio}${t.barbero ? ` con ${t.barbero}` : ""}, ${cuando(t.inicio)}. ` +
          'Si contesta que sí va ("confirmo", "ahí estaré"), usa confirmar_cita; si quiere cambiarla, reprogramar_cita; si no puede ir, cancelar_cita.]',
      );
    }
  }
}

/** Si el cliente no contestó el recordatorio en 4 h, se le insiste una sola vez (lo que hace Sofía IA de AgendaPro). */
export async function enviarSeguimientos(ahora = new Date()) {
  const hora = ahora.getHours();
  if (hora < HORARIO_DE_ENVIO.desde || hora >= HORARIO_DE_ENVIO.hasta) return;
  const hace4h = fechaHoraLocal(new Date(ahora.getTime() - 4 * 3600_000));
  const en2h = fechaHoraLocal(new Date(ahora.getTime() + 2 * 3600_000));

  for (const t of memoria.turnosSinConfirmar(hace4h, en2h)) {
    memoria.actualizarTurno(t.id, "seguimiento", 1);
    const nombre = t.nombre.split(" ")[0];
    const texto =
      `Hola ${nombre} 👋 ¿Nos confirmas tu cita de ${t.servicio} el ${cuando(t.inicio)}? ` +
      "Respóndeme *Confirmo*, o dime si prefieres cambiarla a otro horario.";
    const enviado = await escribirAlCliente(t.telefono, texto, config.whatsapp.plantillaSeguimiento, [nombre, t.servicio, cuando(t.inicio)]);
    if (enviado) memoria.agregarNota(t.telefono, `[Seguimiento automático: se le volvió a pedir que confirme la cita #${t.id}.]`);
  }
}

/** Resumen del día y agenda de mañana para el dueño, más un respaldo de la base. */
async function cierreDelDia(hoy: string) {
  try {
    const destino = memoria.respaldar(hoy);
    if (destino) console.log(`💾 Respaldo guardado en ${destino}`);
  } catch (e) {
    console.error("Error haciendo el respaldo:", e);
  }
  if (config.resumenDiarioHora) await avisarAlDueno(`${resumen("hoy")}\n\n${agendaDelDia(sumarDias(hoy, 1))}`);
}

export function iniciarTareas() {
  const horaCierre = /^\d{2}:\d{2}$/.test(config.resumenDiarioHora) ? config.resumenDiarioHora : "23:00";
  // Si el servidor arranca después de la hora de cierre, ese día ya no se repite el resumen.
  const [hoyAlArrancar, horaAlArrancar] = fechaHoraLocal(new Date()).split("T");
  let ultimoCierre = horaAlArrancar >= horaCierre ? hoyAlArrancar : "";
  let ultimoRecordatorio = 0;

  setInterval(async () => {
    try {
      const [hoy, hora] = fechaHoraLocal(new Date()).split("T");
      if (hora >= horaCierre && ultimoCierre !== hoy) {
        ultimoCierre = hoy;
        await cierreDelDia(hoy);
      }
      if (Date.now() - ultimoRecordatorio > 10 * 60_000) {
        ultimoRecordatorio = Date.now();
        await enviarRecordatorios();
        await enviarSeguimientos();
      }
    } catch (e) {
      console.error("Error en las tareas programadas:", e);
    }
  }, 30_000);
}
