/** Time helpers. All timestamps in mnemo are ISO-8601 strings (UTC). */

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days elapsed between `from` and `to`. Never negative. */
export function daysBetween(from: string | Date, to: string | Date): number {
  const a = typeof from === 'string' ? parseIso(from) : from;
  const b = typeof to === 'string' ? parseIso(to) : to;
  if (!a || !b) return 0;
  const ms = b.getTime() - a.getTime();
  return Math.max(0, ms / 86_400_000);
}

export function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** True when `iso` is strictly before `reference`. */
export function isBefore(iso: string | null, reference: Date): boolean {
  const d = parseIso(iso);
  return d !== null && d.getTime() < reference.getTime();
}
