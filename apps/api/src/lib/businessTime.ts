/**
 * Jakarta-based working calendar for SLA: Phase 6 owner-provided source.
 * Jakarta is fixed UTC+07, no daylight-saving transition.
 */
export interface Calendar {
  mode: '24x7' | 'BUSINESS';
  startMin: number; endMin: number; weekdays: number[]; holidays: Set<string>;
}
const OFFSET = 7 * 60;
const toLocal = (d: Date) => d.getTime() / 60000 + OFFSET;
const fromLocal = (m: number) => new Date(Math.round((m - OFFSET) * 60000));
const isoDow = (day: number) => ((day + 3) % 7) + 1;
const dayStr = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);
const working = (day: number, c: Calendar) =>
  c.weekdays.includes(isoDow(day)) && !c.holidays.has(dayStr(day));

export function addBusinessMinutes(start: Date, minutes: number, cal: Calendar): Date {
  if (cal.mode === '24x7') return new Date(start.getTime() + minutes * 60000);
  let t = toLocal(start), remaining = minutes;
  for (let guard = 0; guard < 4000; guard++) {
    const day = Math.floor(t / 1440);
    if (working(day, cal)) {
      const open = day * 1440 + cal.startMin, close = day * 1440 + cal.endMin;
      if (t < open) t = open;
      if (t < close) {
        const avail = close - t;
        if (remaining <= avail) return fromLocal(t + remaining);
        remaining -= avail;
      }
    }
    t = (day + 1) * 1440;
  }
  throw new Error('Business calendar does not contain an accessible working day');
}

export function businessMinutesBetween(a: Date, b: Date, cal: Calendar): number {
  if (b <= a) return 0;
  if (cal.mode === '24x7') return (b.getTime() - a.getTime()) / 60000;
  const start = toLocal(a), end = toLocal(b); let total = 0;
  for (let day = Math.floor(start / 1440); day <= Math.floor(end / 1440); day++) {
    if (!working(day, cal)) continue;
    const open = Math.max(start, day * 1440 + cal.startMin);
    const close = Math.min(end, day * 1440 + cal.endMin);
    if (close > open) total += close - open;
  }
  return total;
}
