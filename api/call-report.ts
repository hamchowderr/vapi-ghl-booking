// api/call-report.ts
// Handles the Vapi "end-of-call-report" server message and writes the call
// summary to the caller's GHL contact as a Note (GHL has no dedicated call-summary
// field; Notes append, so each call keeps its own entry).
//
// Wire-up: set the ASSISTANT's server.url to this route and keep
// serverMessages including "end-of-call-report".
//
// contactId comes from the per-call cache (set at call start by assistant-request);
// falls back to a phone lookup if the cache missed/expired.

import {
  getClientByInbound,
  getContactByPhone,
  upsertContactByPhone,
  createNote,
} from "../lib/ghl.js";
import { getCallState } from "../lib/cache.js";

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as any;
    const msg = body?.message;
    if (msg?.type !== "end-of-call-report") {
      return Response.json({}, { status: 200 }); // ignore other server messages
    }

    const cfg = getClientByInbound();
    const callId: string | undefined = msg?.call?.id;
    const summary: string | undefined =
      msg?.analysis?.summary ?? msg?.summary ?? msg?.call?.analysis?.summary;

    if (!summary) {
      console.error("call-report: no summary in payload");
      return Response.json({}, { status: 200 });
    }

    // Resolve the contact: prefer the cached contactId, else look up by caller number.
    let contactId: string | null = callId
      ? (await getCallState(callId).catch(() => null))?.contactId ?? null
      : null;
    const num: string | undefined = msg?.customer?.number ?? msg?.call?.customer?.number;
    if (!contactId && num) {
      contactId = (await getContactByPhone(cfg, num))?.id ?? null;
    }
    // Brand-new caller who never booked: no contact exists yet. Create one so the
    // summary has somewhere to live — we save a summary for EVERY caller.
    if (!contactId && num) {
      const name: string | undefined = msg?.customer?.name ?? msg?.call?.customer?.name;
      contactId = await upsertContactByPhone(
        cfg,
        num,
        name ? { name } : undefined
      ).catch((e) => {
        console.error("call-report: contact create failed:", e);
        return null;
      });
    }
    if (!contactId) {
      console.error("call-report: no caller number; cannot create contact for summary");
      return Response.json({}, { status: 200 });
    }

    const reason = msg?.endedReason ? ` (${msg.endedReason})` : "";
    const note = `📞 AI phone call summary${reason}\n\n${summary}`;
    await createNote(cfg, contactId, note);

    return Response.json({}, { status: 200 });
  } catch (err) {
    console.error("call-report error:", err);
    return Response.json({}, { status: 200 }); // never fail the webhook
  }
}
