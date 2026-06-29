// lib/cache.ts
// Per-call shared state: written at assistant-request, read by both tool handlers.
//
// Two backends, chosen at runtime so the deployer/client never has to set up a
// separate cache service:
//   • Netlify → native Netlify Blobs. ZERO config: auto-provisioned, no account,
//     no env vars. Used automatically whenever process.env.NETLIFY is set.
//   • else (Vercel / local / other) → Upstash Redis REST (UPSTASH_* or the
//     Vercel-injected KV_REST_API_*).
// Same CallState shape + get/set API either way — nothing else in the app changes.
//
// Why this matters: the cache is NOT just a latency nicety. The tool handlers read
// contactId, slots, the cached caller number, and upcomingApptId from here. Without
// it, reschedule silently degrades to a double-book and unrecognized callers can
// fail to book. So we want it on by default with no setup — which is exactly what
// Netlify Blobs gives us.

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

// Netlify sets NETLIFY=true in its build + function runtime. Presence of it is how
// we know to use Blobs instead of Upstash.
const onNetlify = Boolean(process.env.NETLIFY);

// Upstash / Vercel KV REST creds (used only when NOT on Netlify). `||` (not `??`)
// so an empty or leftover-placeholder UPSTASH var falls through to KV_REST_API_*.
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

// ── Netlify Blobs backend ──────────────────────────────────────────────────
const STORE_NAME = "vapi-call-state";
// Cached across warm invocations. getStore() is called lazily (inside the request,
// never at module top-level) so it picks up Netlify's auto-injected blobs context.
let blobStore: any;
async function getBlobStore() {
  if (!blobStore) {
    const { getStore } = await import("@netlify/blobs");
    // Strong consistency: the write at assistant-request must be visible to the
    // tool handlers that read it seconds later (the default eventual model can lag
    // up to ~60s across regions — that would be a cache miss on every call).
    blobStore = getStore({ name: STORE_NAME, consistency: "strong" });
  }
  return blobStore;
}

// Netlify Blobs has no native TTL, so we wrap the state with an expiry and treat
// expired reads as a miss — emulating Upstash's EX. (Best-effort delete on read.)
interface Wrapped {
  state: CallState;
  expiresAt: number;
}

export async function setCallState(
  callId: string,
  state: CallState,
  ttlSeconds = 1800
): Promise<void> {
  if (onNetlify) {
    const store = await getBlobStore();
    const wrapped: Wrapped = { state, expiresAt: Date.now() + ttlSeconds * 1000 };
    await store.setJSON(key(callId), wrapped);
    return;
  }
  // No cache configured (e.g. Vercel without the Upstash integration) → no-op.
  // Booking still works; reschedule + low-latency degrade. Don't hard-fail.
  if (!URL_ || !TOKEN) return;
  const cmd = ["SET", key(callId), JSON.stringify(state), "EX", String(ttlSeconds)];
  const res = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`cache set ${res.status}`);
}

export async function getCallState(callId: string): Promise<CallState | null> {
  if (onNetlify) {
    const store = await getBlobStore();
    const wrapped = (await store.get(key(callId), { type: "json" })) as Wrapped | null;
    if (!wrapped) return null;
    if (Date.now() > wrapped.expiresAt) {
      await store.delete(key(callId)).catch(() => {}); // best-effort TTL cleanup
      return null;
    }
    return wrapped.state;
  }
  if (!URL_ || !TOKEN) return null;
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
