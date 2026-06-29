# VAPI × GoHighLevel Voice Booking (single client)

A VAPI voice assistant that books, reschedules, and confirms GoHighLevel
appointments — running on Vercel Functions. Built for low latency: the slow
work (availability, caller lookup, existing-appointment check) is prefetched at
call start and cached, so the live conversation only does a slot re-check + write.

## Architecture

```
Caller dials
   │
   ▼
/api/assistant-request   ← fires once at call start (≤7.5s, hard deadline)
   │  parallel, ≤5s budget:
   │   • getContactByPhone   (read-only — no junk contacts)
   │   • getFreeSlots        (next 10 days)
   │   • getUpcomingAppointment (known callers only)
   │  → cache by call.id (Upstash) + inject vars into the assistant
   ▼
Conversation
   ├─ "what's open?"        → answered from injected {{availabilitySummary}} (no tool call)
   ├─ checkAvailability     → validates a requested time vs cached slots
   └─ calendarBooking       → freshness re-check, then:
                                • new caller  → create contact + appointment, text for email
                                • known caller→ create appointment
                                • reschedule  → PUT-move the existing appointment
                              → SMS confirmation
   ▼
/api/sms-inbound          ← caller texts their email back; we extract + write it to the contact
```

Booking never blocks on email: a GHL appointment needs a contactId, not an email,
so new callers are booked phone-only and the email backfills via SMS.

## Files

| Path | Role |
|------|------|
| `api/assistant-request.ts` | Call-start prefetch + variable injection |
| `api/check-availability.ts` | `checkAvailability` tool handler |
| `api/calendar-booking.ts` | `calendarBooking` tool handler (book / reschedule) |
| `api/sms-inbound.ts` | Inbound-SMS webhook (Twilio / Telnyx / GHL) → email backfill |
| `lib/ghl.ts` | GHL REST calls + single-client config from env |
| `lib/slots.ts` | Slot matching + speech formatting |
| `lib/sms.ts` | Provider-agnostic SMS send (ghl / twilio / telnyx / vapi) |
| `lib/cache.ts` | Per-call state (Upstash Redis REST) |
| `vapi-tools.json` | The two tool definitions to `POST /tool` |
| `system-prompt.md` | The assistant system prompt |
| `vercel.json` | Region pin (`pdx1`, near VAPI us-west-2) + duration |

## Setup

1. `npm install`
2. `cp .env.example .env.local` and fill it in (see that file for every var).
3. `vercel link`
4. `vercel dev` to run locally, or `vercel --prod` to deploy.
5. Mirror the `.env.local` values in the Vercel dashboard (local env does NOT sync to prod).

## Register the tools

For each object in `vapi-tools.json`, set its `server.url` to your deployed
function URL, then:

```bash
curl -X POST https://api.vapi.ai/tool \
  -H "Authorization: Bearer $VAPI_PRIVATE_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{ ...one tool object... }
JSON
```

Attach the returned tool ids to the assistant via `model.toolIds`.

## Wire the webhooks

- **Call start:** set the phone number's `server.url` → `https://YOUR-APP/api/assistant-request`
- **Inbound SMS:** point your provider's inbound webhook → `https://YOUR-APP/api/sms-inbound`
  - Twilio: the number's "A message comes in" webhook
  - Telnyx: the messaging profile's inbound webhook
  - GHL: an inbound-message webhook/workflow

## Set the system prompt

Put `system-prompt.md` into the assistant's system prompt. Replace the
`[BRACKETED]` placeholders. The `{{double_brace}}` values are injected by
`/api/assistant-request` — leave them.

## Verify against live data before trusting in production

These are parsed defensively but should be confirmed against a real payload:

- [ ] **GHL free-slots** response shape for your calendar type (date-keyed `{ slots: [...] }`)
- [ ] **GHL `/contacts/{id}/appointments`** wrapper key (`events` vs `appointments`)
- [ ] **GHL inbound-SMS webhook** field names (varies by webhook/workflow setup; Twilio + Telnyx branches are stable)
- [ ] **GHL create/update appointment** accepts the `timezone` field alongside offset-aware `startTime`

## Known gaps / next steps

- VAPI tool result token limit is 100 by default; results are kept short to fit. Raise only if needed.
- Withheld caller ID falls back to spoken collection (handled in the prompt).
- `closures` env vars are informational only right now — free-slots already excludes closed days.
