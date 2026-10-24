// Tareas que corren solas mientras el servidor está prendido.
import { config } from "./config.js";
import { diaDeLaSemana, fechaHoraLocal, sumarDias } from "./fechas.js";
import { agendaDelDia, resumen } from "./insights.js";
import * as memoria from "./memoria.js";
import { avisarAlDueno, enviarPlantilla } from "./whatsapp.js";

/** Recordatorio por plantilla a los clientes con turno en las próximas 24 h. */
export async function enviarRecordatorios() {
  const plantilla = config.whatsapp.plantillaRecordatorio;
  if (!plantilla) return;
  const ahora = new Date();
  const turnos = memoria.turnosParaRecordar(fechaHoraLocal(ahora), fechaHoraLocal(new Date(ahora.getTime() + 24 * 3600_000)));
  for (const t of turnos) {
    // Se marca antes de enviar para no repetirlo si el envío falla una y otra vez.
    memoria.actualizarTurno(t.id, "recordado", 1);
    const [fecha, hora] = t.inicio.split("T");
    const [, mes, dia] = fecha.split("-");
    await enviarPlantilla(t.telefono, plantilla, [t.nombre, t.servicio, `${diaDeLaSemana(fecha)} ${dia}/${mes} a las ${hora}`]);
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
      }
    } catch (e) {
      console.error("Error en las tareas programadas:", e);
    }
  }, 30_000);
}
