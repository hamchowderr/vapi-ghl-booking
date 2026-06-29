// lib/sms.ts
// One sendSms() with adapters. The provider is chosen per client in config, so
// the same code serves a client on their GHL number, their own Twilio, or VAPI.
//
//   "ghl"    -> POST /conversations/messages (LC Phone). Reply auto-threads to
//               the contact in GHL; cleanest end-to-end.
//   "twilio" -> client's own number. Reply hits Twilio's inbound webhook, which
//               you point at /api/sms-inbound.
//   "vapi"   -> the assistant sends via its built-in `sms` tool, not this server.
//               (Receive still routes to /api/sms-inbound.)

import type { ClientConfig } from "./ghl.js";

const GHL_BASE = "https://services.leadconnectorhq.com";

export async function sendSms(
  cfg: ClientConfig,
  opts: { to: string; body: string; contactId?: string | null }
): Promise<void> {
  switch (cfg.sms.provider) {
    case "ghl":
      return sendViaGhl(cfg, opts);
    case "twilio":
      return sendViaTwilio(cfg, opts);
    case "telnyx":
      return sendViaTelnyx(cfg, opts);
    case "vapi":
      // No server-side send: the assistant's sms tool handles it during the call.
      return;
  }
}

async function sendViaGhl(
  cfg: ClientConfig,
  opts: { to: string; body: string; contactId?: string | null }
): Promise<void> {
  if (!opts.contactId) throw new Error("ghl sms requires contactId");
  const res = await fetch(`${GHL_BASE}/conversations/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.pit}`,
      Version: "2021-04-15",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "SMS", contactId: opts.contactId, message: opts.body }),
  });
  if (!res.ok) throw new Error(`ghl-sms ${res.status}: ${await res.text()}`);
}

async function sendViaTwilio(
  cfg: ClientConfig,
  opts: { to: string; body: string }
): Promise<void> {
  const t = cfg.sms.twilio;
  if (!t) throw new Error("twilio config missing");
  const auth = Buffer.from(`${t.accountSid}:${t.authToken}`).toString("base64");
  const form = new URLSearchParams({ To: opts.to, From: t.from, Body: opts.body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );
  if (!res.ok) throw new Error(`twilio-sms ${res.status}: ${await res.text()}`);
}

async function sendViaTelnyx(
  cfg: ClientConfig,
  opts: { to: string; body: string }
): Promise<void> {
  const t = cfg.sms.telnyx;
  if (!t) throw new Error("telnyx config missing");
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: t.from,
      to: opts.to,
      text: opts.body,
      ...(t.messagingProfileId ? { messaging_profile_id: t.messagingProfileId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`telnyx-sms ${res.status}: ${await res.text()}`);
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

/** Pull the first valid-looking email out of a free-text SMS reply. */
export function extractEmail(text: string): string | null {
  const m = (text || "").match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}
