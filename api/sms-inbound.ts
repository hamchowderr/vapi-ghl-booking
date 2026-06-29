// api/sms-inbound.ts
// Single endpoint every provider posts replies to. Twilio sends form-encoded;
// GHL sends JSON. We normalize, pull the email, and backfill it onto the contact.
//
// Wire-up per client:
//   twilio -> set the number's "A message comes in" webhook to this URL
//   ghl    -> add an inbound-message webhook (or workflow) pointing here
//   vapi   -> point the number's messaging webhook here
//
// phoneNumberId can't be read from a raw Twilio/GHL payload, so we key the
// client by the receiving number (the "To"/location) via getClientByInbound().

import { getClientByInbound, getContactByPhone, updateContact } from "../lib/ghl.js";
import { extractEmail } from "../lib/sms.js";

interface Normalized {
  fromPhone?: string;
  toNumber?: string;
  contactId?: string;
  text: string;
}

async function normalize(req: Request): Promise<Normalized> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const b = (await req.json()) as any;
    // Telnyx: { data: { event_type, payload: { from:{phone_number}, to:[{phone_number}], text } } }
    if (b?.data?.payload) {
      if (b.data.event_type && b.data.event_type !== "message.received") {
        return { text: "" }; // delivery receipt / non-inbound -> ignore
      }
      const p = b.data.payload;
      return {
        fromPhone: p?.from?.phone_number,
        toNumber: p?.to?.[0]?.phone_number,
        text: p?.text ?? "",
      };
    }
    // GHL inbound shape (varies by setup): contactId + message/body text.
    return {
      fromPhone: b.phone ?? b.from,
      toNumber: b.to ?? b.locationId,
      contactId: b.contactId,
      text: b.message ?? b.body ?? b.text ?? "",
    };
  }
  // Twilio form-encoded.
  const form = new URLSearchParams(await req.text());
  return {
    fromPhone: form.get("From") ?? undefined,
    toNumber: form.get("To") ?? undefined,
    text: form.get("Body") ?? "",
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const n = await normalize(req);
    const email = extractEmail(n.text);

    if (email && (n.toNumber || n.fromPhone)) {
      const cfg = getClientByInbound(n.toNumber ?? "");
      // Resolve contact: GHL gives it directly; Twilio gives only the phone.
      let contactId = n.contactId ?? null;
      if (!contactId && n.fromPhone) {
        contactId = (await getContactByPhone(cfg, n.fromPhone))?.id ?? null;
      }
      if (contactId) {
        await updateContact(cfg, contactId, { email });
      }
    }
  } catch (err) {
    console.error("sms-inbound error:", err);
  }

  // Twilio expects 200 + (optionally empty) TwiML; GHL just needs 200.
  return new Response("<Response></Response>", {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
