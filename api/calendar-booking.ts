// api/calendar-booking.ts
// Tool handler for `calendarBooking`. The contactId is already resolved at call
// start and read from cache (the short-circuit). If it's missing (caller ID
// withheld / prefetch skipped), we fall back to an upsert using name/email/phone.
//
// Before writing, we re-check that the one chosen slot is still open (it may have
// been taken between prefetch and confirmation). If gone, we return alternatives
// instead of booking blindly.

import {
  getClientConfig,
  getFreeSlots,
  upsertContactByPhone,
  createAppointment,
  updateAppointment,
} from "../lib/ghl.js";
import { getCallState } from "../lib/cache.js";
import { sendSms } from "../lib/sms.js";
import { flatten, findMatch, alternatives, speak, localDate } from "../lib/slots.js";

function firstToolCall(msg: any) {
  const list = msg?.toolCalls ?? msg?.toolCallList ?? [];
  return list[0];
}

function parseArgs(tc: any): Record<string, any> {
  const a = tc?.function?.arguments ?? tc?.arguments ?? {};
  return typeof a === "string" ? JSON.parse(a) : a;
}

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

export async function POST(req: Request): Promise<Response> {
  let toolCallId = "";
  try {
    const body = (await req.json()) as any;
    const msg = body?.message;
    const tc = firstToolCall(msg);
    toolCallId = tc?.id ?? "";
    const args = parseArgs(tc);

    const requestedSlot = String(args.requestedSlot ?? "");
    const callId: string | undefined = msg?.call?.id;
    const phoneNumberId: string = msg?.call?.phoneNumberId ?? msg?.phoneNumber?.id;
    const callerNumber: string | undefined =
      msg?.call?.customer?.number ?? msg?.customer?.number;

    const cfg = getClientConfig(phoneNumberId);
    const tz = String(args.timezone || cfg.timezone);

    const state = callId ? await getCallState(callId).catch(() => null) : null;

    // Reschedule only takes effect if there's an existing appointment to move.
    const reschedule =
      (args.reschedule === true || String(args.reschedule) === "true") &&
      Boolean(state?.upcomingApptId);

    // contactId is required to CREATE; rescheduling an existing appointment isn't.
    // Prefer the number cached at call start — the tool-call payload doesn't always
    // carry customer.number, so without this an unrecognized caller can't be booked.
    const effectiveNumber = state?.callerNumber || callerNumber || "";
    let contactId = state?.contactId ?? null;
    if (!reschedule && !contactId) {
      contactId = await upsertContactByPhone(cfg, effectiveNumber, {
        name: args.name,
        email: args.email,
      }).catch(() => null);
    }
    if (!reschedule && !contactId) {
      return Response.json(
        {
          results: [
            {
              toolCallId,
              result:
                "I couldn't identify the caller. Collect a name and email, then try booking again.",
            },
          ],
        },
        { status: 200 }
      );
    }

    // Freshness re-check on the single chosen slot.
    const reqMs = Date.parse(requestedSlot);
    const valid = !Number.isNaN(reqMs);
    const start = valid ? reqMs - HALF_DAY_MS : Date.now();
    const end = valid ? reqMs + HALF_DAY_MS : Date.now() + 24 * 60 * 60 * 1000;
    const fresh = flatten(await getFreeSlots(cfg, start, end).catch(() => ({})));
    const stillOpen = valid ? findMatch(fresh, reqMs) : null;

    if (!stillOpen) {
      const anchor = valid ? reqMs : fresh[0]?.ms ?? Date.now();
      const alts =
        alternatives(fresh, anchor, tz)
          .map((s) => `${speak(s.iso, tz)} (${s.iso})`)
          .join(" | ") || "no nearby openings";
      return Response.json(
        {
          results: [
            {
              toolCallId,
              result: `That slot was just taken. Nearest options: ${alts}. Offer one and re-confirm.`,
            },
          ],
        },
        { status: 200 }
      );
    }

    if (reschedule) {
      await updateAppointment(cfg, state!.upcomingApptId!, stillOpen.iso);
    } else {
      // Stamp the qualifying reason onto the title so it's visible on the
      // calendar event itself (full detail still lands in the call-summary note).
      const reason = String(args.reason ?? "").trim();
      const title = reason ? `Discovery call — ${reason}`.slice(0, 100) : "Discovery call";
      await createAppointment(cfg, contactId!, stillOpen.iso, title);
    }

    // Email-by-text + confirmation, both non-blocking. The email never gated the
    // booking; it backfills via /api/sms-inbound when the caller replies.
    const known = state?.known ?? false;
    const when = speak(stillOpen.iso, tz);
    const confirmMsg = reschedule
      ? `Your appointment has been moved to ${when}. Reply C to cancel.`
      : `You're booked for ${when}. Reply C to cancel.`;

    if (callerNumber && cfg.sms.provider !== "vapi") {
      const body =
        known || reschedule
          ? confirmMsg
          : `${confirmMsg} Reply with your email and we'll add it to your record.`;
      // Fire-and-forget; failures don't fail the booking.
      sendSms(cfg, { to: callerNumber, body, contactId }).catch((e) =>
        console.error("confirmation sms:", e)
      );
    }

    const spoken = reschedule
      ? `RESCHEDULED to ${when}. Confirm the new time to the caller; a text confirmation is on its way.`
      : known
      ? `BOOKED for ${when}. Confirm to the caller; a text confirmation is on its way.`
      : `BOOKED for ${when}. Tell the caller you've texted them to confirm and to reply with their email — do NOT ask them to say the email out loud.`;

    return Response.json(
      { results: [{ toolCallId, result: spoken }] },
      { status: 200 }
    );
  } catch (err) {
    console.error("calendar-booking error:", err);
    return Response.json(
      {
        results: [
          {
            toolCallId,
            result: "The booking didn't go through. Apologize and offer to try once more.",
          },
        ],
      },
      { status: 200 }
    );
  }
}
