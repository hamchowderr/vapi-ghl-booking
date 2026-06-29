// lib/cache.ts
// Per-call shared state. Written at assistant-request, read by the tool handlers.
// Backed by Upstash Redis REST (no SDK dependency). Swap for Vercel KV / Edge
// Config if you prefer — only these two functions need to change.

// Works with a standalone Upstash store OR the Vercel Marketplace Redis (Upstash)
// integration — the latter injects KV_REST_API_* names. Same Upstash REST API
// either way, so the fetch calls below are unchanged.
// `||` (not `??`) so an empty or leftover-placeholder UPSTASH var falls through
// to the Vercel-injected KV_REST_API_* instead of shadowing it.
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL!;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN!;

export interface CallState {
  contactId: string | null;
  /** raw caller ID (E.164). Cached so the tool handlers can upsert/book even when
   *  contact recognition missed and the tool-call payload omits customer.number. */
  callerNumber?: string;
  /** true if the caller was found in GHL at call start */
  known: boolean;
  name?: string;
  email?: string;
  /** date string -> ISO slots, as returned by getFreeSlots */
  slots: Record<string, string[]>;
  timezone: string;
  /** echo the resolved config so tool handlers don't re-derive it */
  calendarId: string;
  locationId: string;
  /** soonest existing future appointment, if any (for reschedule handling) */
  upcomingApptId?: string;
  upcomingApptTime?: string;
}

const key = (callId: string) => `call:${callId}`;

export async function setCallState(
  callId: string,
  state: CallState,
  ttlSeconds = 1800
): Promise<void> {
  const cmd = ["SET", key(callId), JSON.stringify(state), "EX", String(ttlSeconds)];
  const res = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`cache set ${res.status}`);
}

export async function getCallState(callId: string): Promise<CallState | null> {
  const cmd = ["GET", key(callId)];
  const res = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`cache get ${res.status}`);
  const { result } = (await res.json()) as { result: string | null };
  return result ? (JSON.parse(result) as CallState) : null;
}
