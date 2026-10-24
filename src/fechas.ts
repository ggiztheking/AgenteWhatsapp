// Todas las fechas se manejan como texto local del negocio ("2026-10-24", "2026-10-24T15:30"),
// usando la zona horaria de la variable TZ.

const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

const dos = (n: number) => String(n).padStart(2, "0");

export function fechaLocal(d: Date): string {
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
}

export function fechaHoraLocal(d: Date): string {
  return `${fechaLocal(d)}T${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

export function diaDeLaSemana(fecha: string): string {
  const [a, m, d] = fecha.split("-").map(Number);
  return DIAS[new Date(a, m - 1, d).getDay()];
}

export function aMinutos(hora: string): number {
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

export function aHora(minutos: number): string {
  return `${dos(Math.floor(minutos / 60))}:${dos(minutos % 60)}`;
}

export function ahoraLegible(): string {
  const ahora = new Date();
  return `${diaDeLaSemana(fechaLocal(ahora))} ${fechaHoraLocal(ahora).replace("T", " ")}`;
}
