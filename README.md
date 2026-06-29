# VAPI × GoHighLevel Voice Booking

A drop-in **AI phone receptionist** for any business running **GoHighLevel** + **VAPI**.
Callers dial your VAPI number, talk to a natural voice assistant, and it **books / reschedules
appointments** straight into your GoHighLevel calendar — over voice, with no human in the loop.

Built for low latency: the slow work (availability, caller lookup, existing-appointment check)
is prefetched at call start and cached, so the live conversation only does a slot re-check + write.

**Stack:** Vercel **or** Netlify Functions (Node) · GoHighLevel REST · per-call cache (Netlify Blobs, or Upstash/Vercel KV) · VAPI

> **Deploys to Vercel or Netlify** from the same repo. The booking logic (`api/*` + `lib/*`)
> is platform-agnostic Web-standard handlers; each platform just has a thin adapter layer
> (`vercel.json` / `netlify.toml` + `netlify/functions/*`). Both keep the same `/api/...` URLs,
> so your VAPI tool + webhook config is identical either way.

---

## Which platform? (Vercel or Netlify)

**You don't choose inside the repo — you choose by where you deploy it.** This one repo deploys to
either host; each one reads only its own config and ignores the other's:

| If you deploy to… | It uses | It ignores |
|-------------------|---------|------------|
| **Vercel** | `vercel.json` + the `api/*` functions | `netlify.toml`, `netlify/` |
| **Netlify** | `netlify.toml` + `netlify/functions/*` (which import the same `api/*` logic) | `vercel.json` |

So connecting the repo to Vercel makes it a Vercel app; connecting it to Netlify makes it a Netlify
app. Both can even coexist (deploy to both at once) without conflict. **Rule of thumb: pick the host
your account/client already uses.** If you only ever want one, you *may* delete the other's files
(`vercel.json`, or `netlify.toml` + `netlify/`), but you don't have to — leaving both is harmless.

## One-click deploy

Use the button for the platform you picked above — it clones this repo into **your** GitHub + host,
prompts you for the env vars below, and deploys the backend. **That gets the hosting half done in
one click.**

**Vercel:**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fhamchowderr%2Fvapi-ghl-booking&env=GHL_PIT,GHL_CALENDAR_ID,GHL_LOCATION_ID,GHL_ASSIGNED_USER_ID,GHL_TIMEZONE,VAPI_ASSISTANT_ID,SMS_PROVIDER&envDescription=Your%20GoHighLevel%20%2B%20VAPI%20credentials&envLink=https%3A%2F%2Fgithub.com%2Fhamchowderr%2Fvapi-ghl-booking%23environment-variables&project-name=vapi-ghl-booking&repository-name=vapi-ghl-booking)

**Netlify:**

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/hamchowderr/vapi-ghl-booking)

(`netlify.toml` prompts for the same env vars during the deploy flow.)

After the one-click deploy, you still do two things:

1. **Per-call cache** (holds caller + slot + appointment state between the call-start prefetch
   and the tool handlers). This is **needed for reschedule and reliable booking**, not just
   latency — without it, reschedule silently double-books and some callers can fail to book.
   - **Netlify** — **nothing to do.** The code uses **Netlify Blobs**, which is built in and
     auto-provisioned (no account, no env vars, no setup). ✅
   - **Vercel** — add the **Upstash for Redis** integration (one click). It auto-injects
     `KV_REST_API_*`, which the code reads. (Or set `UPSTASH_REDIS_REST_URL` / `_TOKEN` yourself.)
2. **Set up your VAPI assistant** (the voice side — see [VAPI setup](#vapi-setup) below). This is
   the one part that isn't clickable. The deployed `/api/...` URLs are identical on both platforms,
   so the VAPI wiring is the same regardless of host.

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
   │  → cache state by call.id (Netlify Blobs / Upstash) + inject into the assistant:
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

Set in **Vercel → Settings → Environment Variables** or **Netlify → Site config → Environment
variables** (Production). Locally they live in `.env.local` (gitignored). **Never commit secrets.**
See `.env.example` for the full list.

| Var | Required | Notes |
|-----|----------|-------|
| `GHL_PIT` | ✅ | GoHighLevel Private Integration Token (calendars + contacts scopes) |
| `GHL_CALENDAR_ID` | ✅ | The calendar to book into |
| `GHL_LOCATION_ID` | ✅ | Your GHL sub-account (location) id |
| `GHL_ASSIGNED_USER_ID` | ◻︎ | User the appointment is assigned to → drives **which Gmail** it syncs to |
| `GHL_TIMEZONE` | ◻︎ | IANA tz of the calendar (e.g. `America/Chicago`; default `America/New_York`) |
| `SMS_PROVIDER` | ◻︎ | `ghl` (default) · `twilio` · `telnyx` · `vapi` |
| `VAPI_ASSISTANT_ID` | ✅ | The assistant `/api/assistant-request` returns |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | ◻︎ | Per-call cache, **non-Netlify only**. On **Netlify** the cache uses built-in **Netlify Blobs** automatically — leave these unset. On **Vercel**, the **Upstash for Redis** integration auto-injects `KV_REST_API_URL`/`_TOKEN` instead (code accepts either). |

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
| `lib/cache.ts` | Per-call state — Netlify Blobs (on Netlify) or Upstash/Vercel KV REST (elsewhere) |
| `vapi-tools.json` | The two tool definitions to register with VAPI |
| `system-prompt.md` | Customizable assistant system prompt (fill the `[BRACKETED]` parts) |
| `dev-server.ts` · `dev-load-env.ts` · `dev-redis.compose.yml` | Local dev harness |
| `vercel.json` | Vercel: region pin + function duration |
| `netlify.toml` | Netlify: build/functions config + one-click env prompts |
| `netlify/functions/*.mts` | Netlify adapters — re-export the `api/*` handlers at the same `/api/*` URLs |
| `public/index.html` | Placeholder landing page (Netlify publish dir) |

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
representative of the deployed experience — judge call quality against the deployed host.

**Netlify-native local dev (optional):** `npm run dev:netlify` runs `netlify dev`, which serves the
functions at the real `/api/*` paths with Netlify's routing and gives you a **sandboxed local
Netlify Blobs store** for the cache (no Redis/docker needed). It loads env from a `.env` file (and
your linked Netlify site), so copy `.env.example` to `.env` for this path. The `tsx` harness above
(which reads `.env.local` and uses the Upstash/Redis path) still works and is host-agnostic.

---

## Deploy

```bash
# Vercel
npm run deploy            # alias of deploy:vercel → vercel --prod

# Netlify (after `netlify link` once, or use the one-click button above)
npm run deploy:netlify    # netlify deploy --prod
```

After changing env vars, **redeploy** so functions pick them up.

**Netlify notes:**
- Functions live in `netlify/functions/*.mts` as thin wrappers around the shared `api/*` handlers,
  and `config.path` in each maps them to the same `/api/...` URLs as Vercel — VAPI config doesn't change.
- Latency / region: Netlify Functions default to **US East (cmh / Ohio)**. Netlify **does** offer
  the same region Vercel pins to — **`pdx` (US West, Oregon, near VAPI's us-west-2)** — but you set
  it in the **UI** (Project config → Build & deploy → Functions region) on **Pro/Enterprise** plans,
  not in `netlify.toml`. So the latency parity is achievable; the only real gap is that Vercel pins
  region **free, in `vercel.json`**, whereas Netlify makes it a **paid-plan UI toggle**. If the VAPI
  legs feel slow on Netlify, switch the functions region to `pdx`.
- **Cache: zero setup.** `lib/cache.ts` uses **Netlify Blobs** when `process.env.NETLIFY` is set —
  built-in, auto-provisioned, no env vars. (Off Netlify it falls back to Upstash/Vercel KV REST.)
  Strong consistency is used so the call-start write is readable by the tool handlers immediately.

---

## Hard invariants (don't break these)

1. **ESM needs `.js` import extensions.** `package.json` is `"type": "module"`; both Vercel (Node
   ESM) and Netlify (esbuild) resolve relative imports by the written `.js` path — always
   `../lib/ghl.js`, and the `netlify/functions/*` wrappers import `../../api/<name>.js` the same way.
   Local `tsx` is lenient, but `npm run typecheck` (and the deploy) catches a wrong extension.
2. **`/api/assistant-request` must answer in ≤6s** (7.5s VAPI deadline). The prefetch is wrapped
   in a 5s `Promise.race` budget — keep it.
3. **Tool handlers always return HTTP 200.** Any other status is ignored by VAPI.
4. **GHL Version headers differ by resource:** calendars `2021-04-15`, contacts `2021-07-28`.
5. **The appointments endpoint returns offset-LESS times** (calendar-local, e.g. `"2026-06-29 15:00:00"`).
   Normalize with `zonedToIso()` before any time math — parsing naïvely uses the server tz
   (UTC on both Vercel and Netlify/AWS Lambda) and shifts every comparison by hours.
6. **Caller number is cached at call start** so booking still works if contact recognition
   misses (the tool-call payload doesn't always carry `customer.number`).
7. **Never confirm a booking the tool didn't actually return.** Read date/time back from the
   tool result, not from intent.
8. **Near-zero runtime dependencies** — native `fetch`, `Buffer`, `Intl`, `URLSearchParams`. The
   only runtime dep is `@netlify/blobs` (the Netlify cache backend, loaded via dynamic import only
   when `process.env.NETLIFY` is set). Don't add others — bundle size affects cold starts.

---

## Testing

Automated regression uses **VAPI Simulations** (`/eval/simulation/*`, chat transport) with
mocked tools — e.g. a "book a discovery call" scenario asserting `appointment_booked = true`.
`npm run typecheck` must pass before any deploy.
