# VAPI × GoHighLevel Voice Booking

A drop-in **AI phone receptionist** for any business running **GoHighLevel** + **VAPI**.
Callers dial your VAPI number, talk to a natural voice assistant, and it **books / reschedules
appointments** straight into your GoHighLevel calendar — over voice, with no human in the loop.

Built for low latency: the slow work (availability, caller lookup, existing-appointment check)
is prefetched at call start and cached, so the live conversation only does a slot re-check + write.

**Stack:** Vercel Functions (Node) · GoHighLevel REST · Upstash Redis (optional) · VAPI · **zero runtime dependencies**

---

## One-click deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhamchowderr%2Fvapi-ghl-booking&env=GHL_PIT,GHL_CALENDAR_ID,GHL_LOCATION_ID,GHL_ASSIGNED_USER_ID,GHL_TIMEZONE,VAPI_ASSISTANT_ID,SMS_PROVIDER&envDescription=Your%20GoHighLevel%20%2B%20VAPI%20credentials&envLink=https%3A%2F%2Fgithub.com%2Fhamchowderr%2Fvapi-ghl-booking%23environment-variables&project-name=vapi-ghl-booking&repository-name=vapi-ghl-booking)

The button clones this repo into **your** GitHub + Vercel, prompts you for the env vars below,
and deploys the backend. **That gets the Vercel half done in one click.** You still do two things:

1. **(Optional) Add Redis** — in your new Vercel project, add the **Upstash for Redis** integration
   (one click). It auto-injects `KV_REST_API_*`. Without it the app still books appointments;
   reschedule + lowest latency need it.
2. **Set up your VAPI assistant** (the voice side — see [VAPI setup](#vapi-setup) below). This is
   the one part that isn't clickable.

---

## How a call flows

```
Caller dials your VAPI number
   │
   ▼
/api/assistant-request      ← fires once at call start (≤7.5s hard VAPI deadline)
   │  in parallel (≤5s budget):
   │   • getContactByPhone      (read-only — recognize the caller)
   │   • getFreeSlots           (next 10 days)
   │   • getUpcomingAppointment (known callers, for reschedule)
   │  → cache state by call.id (Upstash) + inject into the assistant:
   │      {{now}} {{availabilitySummary}} {{callerName}} {{contactKnown}} …
   ▼
Conversation
   ├─ offers real open times from {{availabilitySummary}} (no tool call)
   ├─ checkAvailability   → validates a specific requested time
   └─ calendarBooking     → books / reschedules the confirmed slot:
                              • new caller   → create contact + appointment, text for email
                              • known caller → create appointment
                              • reschedule   → move the existing appointment
   ▼
/api/sms-inbound      ← new caller texts their email back → written to the contact
/api/call-report      ← end-of-call: AI summary saved as a Note on the caller's contact
```

Booking never blocks on email: a GHL appointment needs a `contactId`, not an email, so new
callers are booked phone-only and the email backfills via SMS.

---

## Environment variables

Set in **Vercel → Settings → Environment Variables** (Production). Locally they live in
`.env.local` (gitignored). **Never commit secrets.** See `.env.example` for the full list.

| Var | Required | Notes |
|-----|----------|-------|
| `GHL_PIT` | ✅ | GoHighLevel Private Integration Token (calendars + contacts scopes) |
| `GHL_CALENDAR_ID` | ✅ | The calendar to book into |
| `GHL_LOCATION_ID` | ✅ | Your GHL sub-account (location) id |
| `GHL_ASSIGNED_USER_ID` | ◻︎ | User the appointment is assigned to → drives **which Gmail** it syncs to |
| `GHL_TIMEZONE` | ◻︎ | IANA tz of the calendar (e.g. `America/Chicago`; default `America/New_York`) |
| `SMS_PROVIDER` | ◻︎ | `ghl` (default) · `twilio` · `telnyx` · `vapi` |
| `VAPI_ASSISTANT_ID` | ✅ | The assistant `/api/assistant-request` returns |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | ◻︎ | Per-call cache. The Vercel **Upstash for Redis** integration auto-injects `KV_REST_API_URL`/`_TOKEN` instead — the code accepts either. Omit to run without a cache (reschedule degrades). |

`VAPI_PRIVATE_KEY` is **admin-only** (registering tools / patching the assistant from your
machine) — the deployed functions never call VAPI, so it is not a runtime requirement.
`closures` and the Twilio/Telnyx vars are only needed for those specific SMS providers.

---

## VAPI setup

The voice side, done once in the VAPI dashboard or API:

1. **Create an assistant.** Paste `system-prompt.md` as its system prompt and fill the
   `[BRACKETED]` placeholders for your business. Leave the `{{double_brace}}` values — those are
   injected at call start. Put the assistant id in `VAPI_ASSISTANT_ID`.
2. **Register the two tools** in `vapi-tools.json` (`POST /tool`), pointing each `server.url` at
   your deployed domain (`…/api/check-availability`, `…/api/calendar-booking`). Attach the
   returned tool ids to the assistant.
3. **Set the assistant's `server.url`** → `…/api/call-report` with `serverMessages: ["end-of-call-report"]`.
4. **Configure the phone number** → set its `server.url` → `…/api/assistant-request`, and
   **remove any static `assistantId`** from the number. ⚠️ This is the part that bites: if the
   number has a static assistant, VAPI uses it directly and **skips** `/api/assistant-request`,
   so no real availability is injected and the assistant will hallucinate times.

Tools must return the VAPI contract `{ results: [{ toolCallId, result }] }` with HTTP **200**;
`result` is a single short line (kept under the ~100-token tool-result limit).

---

## Project structure

| Path | Role |
|------|------|
| `api/assistant-request.ts` | Call-start prefetch + dynamic-variable injection |
| `api/check-availability.ts` | `checkAvailability` tool handler |
| `api/calendar-booking.ts` | `calendarBooking` tool handler (book / reschedule) |
| `api/sms-inbound.ts` | Inbound-SMS webhook (Twilio / Telnyx / GHL) → email backfill |
| `api/call-report.ts` | `end-of-call-report` → writes AI summary Note to the contact |
| `lib/ghl.ts` | All GoHighLevel REST calls + single-client config from env |
| `lib/slots.ts` | Slot matching, speech formatting, timezone normalization |
| `lib/sms.ts` | Provider-agnostic SMS send (ghl / twilio / telnyx / vapi) |
| `lib/cache.ts` | Per-call state (Upstash Redis REST) |
| `vapi-tools.json` | The two tool definitions to register with VAPI |
| `system-prompt.md` | Customizable assistant system prompt (fill the `[BRACKETED]` parts) |
| `dev-server.ts` · `dev-load-env.ts` · `dev-redis.compose.yml` | Local dev harness |
| `vercel.json` | Region pin + function duration |

---

## Local development

`vercel dev` does **not** load `.env.local` (it pulls cloud env), so use the local harness:

```bash
npm install
cp .env.example .env.local        # then fill it in
docker compose -f dev-redis.compose.yml up -d   # local Upstash-compatible Redis (SRH) on :8079
npx tsx watch dev-server.ts       # serves the handlers on http://localhost:3000
npm run typecheck                 # must pass before deploy
```

Point the cache at the local Redis in `.env.local`:

```
UPSTASH_REDIS_REST_URL=http://localhost:8079
UPSTASH_REDIS_REST_TOKEN=localdevtoken
```

To test against real phone calls, expose `:3000` with a tunnel (e.g. ngrok) and point the VAPI
server URLs at it. **Note:** a tunnel + remote GHL adds seconds of latency and is *not*
representative of the deployed experience — judge call quality against the Vercel deploy.

---

## Deploy

```bash
npm run deploy        # vercel --prod
```

After changing env vars, **redeploy** so functions pick them up.

---

## Hard invariants (don't break these)

1. **ESM needs `.js` import extensions.** `package.json` is `"type": "module"`; Vercel runs each
   function in Node ESM, which rejects extensionless relative imports — always `../lib/ghl.js`.
   Local `tsx` is lenient, so **only the deploy catches this.**
2. **`/api/assistant-request` must answer in ≤6s** (7.5s VAPI deadline). The prefetch is wrapped
   in a 5s `Promise.race` budget — keep it.
3. **Tool handlers always return HTTP 200.** Any other status is ignored by VAPI.
4. **GHL Version headers differ by resource:** calendars `2021-04-15`, contacts `2021-07-28`.
5. **The appointments endpoint returns offset-LESS times** (calendar-local, e.g. `"2026-06-29 15:00:00"`).
   Normalize with `zonedToIso()` before any time math — parsing naïvely uses the server tz
   (UTC on Vercel) and shifts every comparison by hours.
6. **Caller number is cached at call start** so booking still works if contact recognition
   misses (the tool-call payload doesn't always carry `customer.number`).
7. **Never confirm a booking the tool didn't actually return.** Read date/time back from the
   tool result, not from intent.
8. **Zero runtime dependencies** — native `fetch`, `Buffer`, `Intl`, `URLSearchParams` only.

---

## Testing

Automated regression uses **VAPI Simulations** (`/eval/simulation/*`, chat transport) with
mocked tools — e.g. a "book a discovery call" scenario asserting `appointment_booked = true`.
`npm run typecheck` must pass before any deploy.
