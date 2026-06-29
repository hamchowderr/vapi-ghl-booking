// api/assistant-request.ts
// Fires once at call start. Vapi POSTs { message: { type: "assistant-request", ... } }
// and expects an assistant (or assistantId + overrides) back within ~7.5s.
//
// We do the two slow things HERE, in parallel, masked by the greeting:
//   1. upsert the caller as a contact (by caller ID) -> contactId
//   2. fetch free-slots for the next N days
// Both go into the per-call cache; a human-readable slot summary + tz + now go
// into variableValues so the model can answer "what's open Tuesday?" with zero
// tool latency.

import { getClientConfig, getFreeSlots, getContactByPhone, getUpcomingAppointment } from "../lib/ghl.js";
import { setCallState } from "../lib/cache.js";
import { speak } from "../lib/slots.js";

const PREFETCH_DAYS = 10;

function nowInTz(tz: string): string {
  // YYYY-MM-DD in the calendar's timezone — the anchor for relative-date math.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Compact summary the model reads from its prompt. One line per day, labeled with
 * the WEEKDAY (so the model never has to compute day-of-week from a date — that was
 * causing "Tuesday, July 1" when July 1 is a Wednesday), and expressed as a RANGE
 * rather than an enumerated list (so the model offers "between 3 and 5" instead of
 * robotically reading every 15-minute slot). checkAvailability still validates the
 * exact time the caller picks against the real cached slots.
 */
function summarize(slots: Record<string, string[]>, tz: string): string {
  const fmtDay = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date(iso));
  const fmtTime = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));

  const lines: string[] = [];
  for (const times of Object.values(slots)) {
    if (!times.length) continue;
    const sorted = [...times].sort();
    const first = fmtTime(sorted[0]);
    const last = fmtTime(sorted[sorted.length - 1]);
    const range = first === last ? first : `${first}–${last} (15-min slots)`;
    lines.push(`${fmtDay(sorted[0])}: ${range}`);
  }
  return lines.join(" | ") || "No open slots in the next " + PREFETCH_DAYS + " days.";
}

export async function POST(req: Request): Promise<Response> {
  let variableValues: Record<string, any> = {};
  let assistantId: string | undefined;

  try {
    const body = (await req.json()) as any;
    const msg = body?.message;
    if (msg?.type !== "assistant-request") {
      return Response.json({}, { status: 200 });
    }

    const phoneNumberId: string = msg?.phoneNumber?.id ?? msg?.call?.phoneNumberId;
    const callId: string = msg?.call?.id;
    const callerNumber: string | undefined = msg?.customer?.number ?? msg?.call?.customer?.number;

    const cfg = getClientConfig(phoneNumberId);
    assistantId = cfg.assistantId;

    const startMs = Date.now();
    const endMs = startMs + PREFETCH_DAYS * 24 * 60 * 60 * 1000;

    // Parallel: contact upsert + slot fetch. Failures degrade gracefully.
    // Hard budget: the assistant-request deadline is a FIXED 7.5s end-to-end, so
    // we cap the prefetch well under it. If GHL is slow, we return the assistant
    // anyway and let the tools recover live (they re-fetch on cache miss).
    const PREFETCH_BUDGET_MS = 5000;
    type Pre = {
      contact: Awaited<ReturnType<typeof getContactByPhone>>;
      slots: Record<string, string[]>;
      upcoming: Awaited<ReturnType<typeof getUpcomingAppointment>>;
    };
    const budget = new Promise<Pre>((resolve) =>
      setTimeout(() => resolve({ contact: null, slots: {}, upcoming: null }), PREFETCH_BUDGET_MS)
    );
    const work: Promise<Pre> = (async () => {
      const [contact, slots] = await Promise.all([
        callerNumber ? getContactByPhone(cfg, callerNumber).catch(() => null) : Promise.resolve(null),
        getFreeSlots(cfg, startMs, endMs).catch(() => ({} as Record<string, string[]>)),
      ]);
      // Only known callers can have an existing appointment to reschedule.
      const upcoming = contact?.id
        ? await getUpcomingAppointment(cfg, contact.id).catch(() => null)
        : null;
      return { contact, slots, upcoming };
    })();
    const { contact, slots, upcoming } = await Promise.race([work, budget]);

    if (callId) {
      await setCallState(callId, {
        contactId: contact?.id ?? null,
        callerNumber,
        known: Boolean(contact),
        name: contact?.name,
        email: contact?.email,
        slots,
        timezone: cfg.timezone,
        calendarId: cfg.calendarId,
        locationId: cfg.locationId,
        upcomingApptId: upcoming?.id,
        upcomingApptTime: upcoming?.startTime,
      }).catch(() => {});
    }

    variableValues = {
      now: nowInTz(cfg.timezone),
      calendarTimezone: cfg.timezone,
      availabilitySummary: summarize(slots, cfg.timezone),
      contactKnown: Boolean(contact),
      // Greet known callers by name; the model can skip name/email collection.
      callerName: contact?.name ?? "",
      // Reschedule branch: the prompt offers to move this instead of double-booking.
      hasUpcomingAppointment: Boolean(upcoming),
      upcomingAppointmentTime: upcoming ? speak(upcoming.startTime, cfg.timezone) : "",
    };
  } catch (err) {
    // Never hard-fail the call — return whatever we have. The tools can recover
    // live (re-fetch slots, fall back to name/email upsert).
    console.error("assistant-request prefetch error:", err);
  }

  return Response.json(
    assistantId ? { assistantId, assistantOverrides: { variableValues } } : { error: "no_config" },
    { status: 200 }
  );
}
