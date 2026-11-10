// Deadline arithmetic in working days (R1-25). Dates are ISO strings 'YYYY-MM-DD'.

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isWorkday(date: string, holidays: ReadonlySet<string>): boolean {
  const dow = new Date(toUtc(date)).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(date);
}

/** Date that lies n working days after start (start itself is not counted). */
export function addWorkdays(start: string, n: number, holidays: ReadonlySet<string>): string {
  let ms = toUtc(start);
  let left = n;
  while (left > 0) {
    ms += DAY_MS;
    if (isWorkday(fromUtc(ms), holidays)) left--;
  }
  return fromUtc(ms);
}

/**
 * Working days in the interval (from, to]. Negative when `to` lies before `from`,
 * so `workdaysBetween(today, due)` is the remaining time and turns negative when overdue.
 */
export function workdaysBetween(from: string, to: string, holidays: ReadonlySet<string>): number {
  if (from === to) return 0;
  const sign = toUtc(to) > toUtc(from) ? 1 : -1;
  const [a, b] = sign > 0 ? [from, to] : [to, from];
  let count = 0;
  for (let ms = toUtc(a) + DAY_MS; ms <= toUtc(b); ms += DAY_MS) {
    if (isWorkday(fromUtc(ms), holidays)) count++;
  }
  return sign * count;
}

export function addMonths(date: string, months: number): string {
  const d = new Date(toUtc(date));
  d.setUTCMonth(d.getUTCMonth() + months);
  return fromUtc(d.getTime());
}

/** Today's calendar date in the given IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export type TrafficLight = 'green' | 'yellow' | 'red' | 'paused';

export function trafficLight(remaining: number, warnWithin: number, paused: boolean): TrafficLight {
  if (paused) return 'paused';
  if (remaining < 0) return 'red';
  if (remaining <= warnWithin) return 'yellow';
  return 'green';
}
