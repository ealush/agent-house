// Recurring schedules: five-field cron (minute hour day-of-month month day-of-week)
// evaluated in an IANA time zone. Pure: no clock, no I/O.
//
// Daylight saving, stated rather than guessed:
//  - a wall time that doesn't exist that day (clocks spring forward over it) is
//    skipped that day: "30 2 * * *" in America/New_York doesn't run on the March
//    change;
//  - a wall time that happens twice (clocks fall back) runs once, the first time
//    (a schedule that runs every hour runs in both: they are two real hours).
// Both are what the wall clock says, which is what "every morning at 9" means.

export type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean; source: string };

export class CronError extends Error {}

const ALIASES: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function field(text: string, min: number, max: number, names?: string[]): { set: Set<number>; any: boolean } {
  const set = new Set<number>();
  const num = (s: string) => {
    const i = names?.indexOf(s.toLowerCase()) ?? -1;
    const n = i >= 0 ? i + (names === MONTHS ? 1 : 0) : Number(s);
    if (!Number.isInteger(n) || n < min || n > max) throw new CronError(`${s} is out of range ${min}–${max}`);
    return n;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`bad step in ${part}`);
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [min, max];
    else if (range.includes('-')) [lo, hi] = range.split('-').map(num) as [number, number];
    else [lo, hi] = [num(range), stepText === undefined ? num(range) : max];
    if (lo > hi) throw new CronError(`empty range ${part}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, any: text === '*' };
}

export function parseCron(expr: string): Cron {
  const source = expr.trim();
  const parts = (ALIASES[source.toLowerCase()] ?? source).split(/\s+/);
  if (parts.length !== 5) throw new CronError('a schedule has five fields: minute hour day month weekday');
  const dow = field(parts[4], 0, 7, DAYS);
  if (dow.set.has(7)) (dow.set.delete(7), dow.set.add(0));
  const dom = field(parts[2], 1, 31);
  return { minute: field(parts[0], 0, 59).set, hour: field(parts[1], 0, 23).set, dom: dom.set, month: field(parts[3], 1, 12, MONTHS).set, dow: dow.set, domAny: dom.any, dowAny: dow.any, source };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws on a time zone the platform doesn't know. */
export function checkZone(tz: string): string {
  try {
    zoneFormatter(tz);
    return tz;
  } catch {
    throw new CronError(`unknown time zone: ${tz}`);
  }
}

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at `ms`. */
export function wallClock(ms: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
  const p: Record<string, string> = {};
  for (const x of zoneFormatter(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), dow: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
}

const key = (w: ReturnType<typeof wallClock>) => `${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute}`;

/** The first moment strictly after `after` (epoch ms) that the schedule names, in `tz`. */
export function nextRun(c: Cron, tz: string, after: number): number | null {
  const skipWall = key(wallClock(after, tz));
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (let guard = 0; guard < 200_000; guard++) {
    const w = wallClock(t, tz);
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? c.dow.has(w.dow) : c.dowAny ? c.dom.has(w.day) : c.dom.has(w.day) || c.dow.has(w.dow);
    if (!c.month.has(w.month) || !dayOk) {
      // On to the next local day (a DST day is 23 or 25 hours: the hour check sorts it out).
      t += (24 * 60 - (w.hour * 60 + w.minute)) * 60_000;
      continue;
    }
    if (!c.hour.has(w.hour)) {
      t += (60 - w.minute) * 60_000;
      continue;
    }
    if (!c.minute.has(w.minute)) {
      t += 60_000;
      continue;
    }
    // The second pass through a fallen-back hour is the same wall time again: once is enough
    // for a fixed time of day (an hourly schedule's repeated hour is a real hour, and runs).
    if (c.hour.size < 24 && key(w) === skipWall) {
      t += 60_000;
      continue;
    }
    return t;
  }
  return null;
}
