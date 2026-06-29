# CLAUDE.md — build & maintenance notes for the coding agent

This is a single-client VAPI × GoHighLevel voice-booking backend on Vercel
Functions. Read this before changing code.

## Stack & constraints

- Vercel Functions, **Node runtime** (not Edge), Web-standard handlers:
  `export async function POST(req: Request): Promise<Response>`.
- **No runtime npm dependencies.** Uses native `fetch`, `Buffer`, `Intl`,
  `URLSearchParams`. Keep it that way — bundle size affects cold starts.
- Region pinned to `pdx1` (near VAPI us-west-2) in `vercel.json`. Do not move it
  to the edge or a multi-region config — the VAPI legs are the latency-critical path.

## Hard invariants (do not break)

1. **`/api/assistant-request` must respond within ~6s** (7.5s is a fixed VAPI
   deadline). The prefetch is wrapped in a 5s `Promise.race` budget; keep it.
2. **Tool handlers always return HTTP 200** with `{ results: [{ toolCallId, result }] }`.
   Any other status is ignored by VAPI. `result` must be a **single-line string**.
3. **Search-first, not upsert, at call start.** `getContactByPhone` is read-only so
   we never create a contact for every inbound call. Contacts are only created at
   booking time (new callers).
4. **Email never blocks booking.** New callers are booked phone-only; email
   backfills via `/api/sms-inbound`. Don't reintroduce a verbal-email step.
5. **GHL Version headers differ by resource:** calendars `2021-04-15`,
   contacts `2021-07-28`. They're set per-call in `lib/ghl.ts`.

## Data flow / shared state

- `lib/cache.ts` holds per-call state keyed by `call.id` (Upstash Redis REST),
  written at `assistant-request`, read by both tool handlers. TTL 30m.
- Config comes from flat env vars via `getClientConfig()` / `getClientByInbound()`
  in `lib/ghl.ts`. **Single client** — the `phoneNumberId` arg is ignored.
  To go multi-client, swap these two functions to query Supabase by `phoneNumberId`;
  nothing else changes.

## SMS providers

`lib/sms.ts` switches on `SMS_PROVIDER`: `ghl` (LC Phone via conversations),
`twilio`, `telnyx`, or `vapi` (assistant's own sms tool — no server send).
`/api/sms-inbound` normalizes Twilio (form), Telnyx (`data.payload` JSON), and
GHL (JSON) inbound shapes, extracts the email, and writes it to the contact.

## Reschedule

`calendarBooking` takes an optional `reschedule` boolean. When true AND a cached
`upcomingApptId` exists, it `PUT`-moves the existing appointment instead of
creating a new one (`updateAppointment`). The prompt sets this when a known caller
chooses to move rather than add.

## TODO / verify before production

- Confirm GHL response shapes against real payloads (see README checklist):
  free-slots structure, `/contacts/{id}/appointments` wrapper key, inbound-SMS fields.
- Confirm create/update appointment accept the `timezone` field.
- Optional: send a "reply Y to confirm jane@x.com" SMS after email extraction
  to catch caller typos.
- Optional: wire `closures` into a deterministic date-resolver if you stop trusting
  GHL free-slots to exclude closed days.

## Testing approach

No live credentials here. Validate by feeding sample provider payloads to each
handler and asserting the `{ results: [...] }` shape and the GHL request bodies.
`npm run typecheck` must pass.
