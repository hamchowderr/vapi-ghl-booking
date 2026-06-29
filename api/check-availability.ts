// api/check-availability.ts
// Tool handler for `checkAvailability`. Reads prefetched slots from cache (fast
// path, no GHL hop). On cache miss it falls back to a live free-slots fetch.
// GHL free-slots already exclude closures/blocked times, so the cached slots are
// authoritative — no separate holiday math needed here.
//
// Returns the Vapi contract: { results: [{ toolCallId, result }] }, HTTP 200,
// result a single-line string (kept short to stay under the 100-token default).

import { getClientConfig, getFreeSlots } from "../lib/ghl.js";
import { getCallState } from "../lib/cache.js";
import { flatten, findMatch, alternatives, speak } from "../lib/slots.js";

function firstToolCall(msg: any) {
  const list = msg?.toolCalls ?? msg?.toolCallList ?? [];
  return list[0];
}

function parseArgs(tc: any): Record<string, any> {
  const a = tc?.function?.arguments ?? tc?.arguments ?? {};
  return typeof a === "string" ? JSON.parse(a) : a;
}

export async function POST(req: Request): Promise<Response> {
  let toolCallId = "";
  try {
    const body = (await req.json()) as any;
    const msg = body?.message;
    const tc = firstToolCall(msg);
    toolCallId = tc?.id ?? "";
    const args = parseArgs(tc);

    const requested = String(args.requestedDateTime ?? "");
    const callId: string | undefined = msg?.call?.id;
    const phoneNumberId: string = msg?.call?.phoneNumberId ?? msg?.phoneNumber?.id;

    const cfg = getClientConfig(phoneNumberId);
    const tz = String(args.timezone || cfg.timezone);

    // Fast path: cached slots. Fallback: live fetch.
    const state = callId ? await getCallState(callId).catch(() => null) : null;
    let slots = state?.slots;
    if (!slots || !Object.keys(slots).length) {
      const start = Date.now();
      const end = start + 10 * 24 * 60 * 60 * 1000;
      slots = await getFreeSlots(cfg, start, end).catch(() => ({}));
    }

    const all = flatten(slots);
    const requestedMs = Date.parse(requested);

    let result: string;
    if (!all.length) {
      result = "No open appointment slots in the next 10 days.";
    } else if (!Number.isNaN(requestedMs) && findMatch(all, requestedMs)) {
      const m = findMatch(all, requestedMs)!;
      result =
        `AVAILABLE: ${speak(m.iso, tz)}. Confirm this with the caller, ` +
        `then call calendarBooking with requestedSlot ${m.iso}.`;
    } else {
      const anchor = Number.isNaN(requestedMs) ? all[0].ms : requestedMs;
      const alts = alternatives(all, anchor, tz)
        .map((s) => `${speak(s.iso, tz)} (${s.iso})`)
        .join(" | ");
      result = `UNAVAILABLE. Nearest options: ${alts}. Offer these to the caller.`;
    }

    return Response.json({ results: [{ toolCallId, result }] }, { status: 200 });
  } catch (err) {
    console.error("check-availability error:", err);
    return Response.json(
      {
        results: [
          {
            toolCallId,
            result:
              "I couldn't check availability just now. Ask the caller to suggest another time.",
          },
        ],
      },
      { status: 200 } // Always 200 — any other status is ignored by Vapi.
    );
  }
}
