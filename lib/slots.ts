// lib/slots.ts
// Slot matching + formatting shared by check-availability and calendar-booking.
// Matching is by absolute instant (ms), not string equality, so offset/format
// differences between the model's ISO and GHL's ISO don't cause false misses.

export interface Slot {
  iso: string;
  ms: number;
}

export function flatten(slots: Record<string, string[]>): Slot[] {
  const out: Slot[] = [];
  for (const arr of Object.values(slots)) {
    for (const iso of arr) {
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms)) out.push({ iso, ms });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/** YYYY-MM-DD in the calendar timezone — for same-day comparisons. */
export function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Human/voice-friendly: "Wednesday, July 1 at 2:00 PM". */
export function speak(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Exact match within 60s of the requested instant. */
export function findMatch(all: Slot[], requestedMs: number): Slot | null {
  let best: Slot | null = null;
  let bestDiff = Infinity;
  for (const s of all) {
    const d = Math.abs(s.ms - requestedMs);
    if (d < bestDiff) {
      bestDiff = d;
      best = s;
    }
  }
  return best && bestDiff < 60_000 ? best : null;
}

/** Offset (ms) of `tz` at a given UTC instant. West-of-UTC is negative. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date(utcMs))
    .reduce((a: Record<string, string>, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - utcMs;
}

/**
 * Normalize a GHL time string to an offset-aware ISO instant.
 *
 * free-slots returns offset-aware ISO ("…T15:00:00-05:00") — used as-is. But the
 * appointments endpoint returns OFFSET-LESS wall-clock ("2026-06-29 15:00:00")
 * that is local to the CALENDAR timezone. Parsing that with `new Date()` uses the
 * SERVER's tz (UTC on Vercel, PT on this dev box), shifting the time by hours —
 * which corrupts both the spoken time AND the `startTime > now` "is it upcoming?"
 * check. This re-anchors offset-less strings to `tz` and returns a normal ISO the
 * rest of the pipeline can `Date.parse` safely. Already-zoned strings pass through.
 */
export function zonedToIso(raw: string, tz: string): string {
  const s = (raw || "").trim();
  if (!s) return s;
  // Already offset-aware (has 'T' and a Z or ±HH:MM) -> leave it.
  if (s.includes("T") && /([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return s; // unknown shape -> return unchanged
  const [, y, mo, d, h, mi, se] = m;
  // Treat the wall clock as if UTC, then correct by tz's offset at that instant.
  let utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0);
  const off1 = tzOffsetMs(utc, tz);
  utc -= off1;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off1) utc += off1 - off2; // DST-boundary correction
  return new Date(utc).toISOString();
}

/** Up to n alternatives: same calendar day first, else next chronological. */
export function alternatives(
  all: Slot[],
  requestedMs: number,
  tz: string,
  n = 3
): Slot[] {
  if (!all.length) return [];
  const reqDay = localDate(new Date(requestedMs).toISOString(), tz);
  const sameDay = all.filter((s) => localDate(s.iso, tz) === reqDay);
  if (sameDay.length) return sameDay.slice(0, n);
  const after = all.filter((s) => s.ms >= requestedMs);
  return (after.length ? after : all).slice(0, n);
}
