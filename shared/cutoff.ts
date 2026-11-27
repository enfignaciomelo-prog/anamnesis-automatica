/**
 * Corte diario: 23:59:00 en America/Santiago, calculado con la base de zonas
 * horarias (Intl), sin desplazamiento UTC fijo, para respetar el horario de
 * verano e invierno de Chile. Se usa en el servidor para hacer cumplir el
 * vencimiento; la interfaz solo lo muestra.
 */
export const CUTOFF_TZ = "America/Santiago";
export const CUTOFF_TIME = { h: 23, m: 59, s: 0 };

interface Local {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz = CUTOFF_TZ): Local {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Desplazamiento (ms) de la zona respecto de UTC en un instante. */
function offsetAt(ms: number, tz: string): number {
  const l = localParts(ms, tz);
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * Instante UTC de una hora local. Si la hora ocurre dos veces (fin del horario
 * de verano) se devuelve la primera; si no existe, la siguiente válida.
 */
export function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz = CUTOFF_TZ): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const candidates = new Set<number>();
  for (const probe of [naive - 36e5 * 14, naive - 36e5 * 2, naive, naive + 36e5 * 2, naive + 36e5 * 14]) {
    candidates.add(naive - offsetAt(probe, tz));
  }
  const valid = [...candidates]
    .filter((ms) => {
      const l = localParts(ms, tz);
      return l.y === y && l.mo === mo && l.d === d && l.h === h && l.mi === mi && l.s === s;
    })
    .sort((a, b) => a - b);
  if (valid.length) return valid[0];
  // Hora inexistente (salto de horario): se usa el primer instante posterior.
  return Math.min(...candidates);
}

/** Próximo corte estrictamente posterior a `fromMs`. */
export function nextDailyCutoff(fromMs: number, tz = CUTOFF_TZ, t = CUTOFF_TIME): number {
  const l = localParts(fromMs, tz);
  let cut = zonedTimeToUtc(l.y, l.mo, l.d, t.h, t.m, t.s, tz);
  if (cut <= fromMs) {
    // Día local siguiente (aritmética de calendario, no +24 h).
    const next = new Date(Date.UTC(l.y, l.mo - 1, l.d + 1));
    cut = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), t.h, t.m, t.s, tz);
  }
  return cut;
}

/** Período diario al que pertenece un instante (fecha local del próximo corte). */
export function periodOf(ms: number, tz = CUTOFF_TZ): string {
  const l = localParts(nextDailyCutoff(ms, tz) - 1000, tz);
  return `${l.y}-${String(l.mo).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
}
