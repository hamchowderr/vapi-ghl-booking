// lib/ghl.ts
// All GHL (LeadConnector) REST calls live here. Note the per-resource Version
// header: calendars use 2021-04-15, contacts use 2021-07-28. Wrong one = silent 4xx.

import { zonedToIso } from "./slots.js";

const GHL_BASE = "https://services.leadconnectorhq.com";

export interface ClientConfig {
  /** VAPI assistant to serve for this client */
  assistantId: string;
  /** GHL Private Integration Token (calendars + contacts scopes) */
  pit: string;
  calendarId: string;
  locationId: string;
  /** Optional GHL user to own the appointment. Matters for per-user Google
   *  calendar sync — set it to the user whose Gmail calendar is connected. */
  assignedUserId?: string;
  /** IANA tz of the *calendar/business*, e.g. "America/New_York" */
  timezone: string;
  /** Closure days the date-resolver should treat as unavailable */
  closures: {
    weekendDays: number[]; // 0=Sun ... 6=Sat
    holidays: string[];    // ["2026-07-04", ...] in calendar tz
  };
  /** Which number sends the "text your email" SMS for new callers. */
  sms: {
    provider: "ghl" | "twilio" | "telnyx" | "vapi";
    twilio?: { accountSid: string; authToken: string; from: string };
    telnyx?: { apiKey: string; from: string; messagingProfileId?: string };
    // "ghl"  -> uses the location's connected LC Phone number (no extra config)
    // "vapi" -> sent by the assistant's built-in sms tool, not this server
  };
}

/**
 * Resolve which client this call belongs to. Keyed by the VAPI phoneNumberId
 * (the dialed number). This is the one place that varies per client — back it
 * with Supabase/Edge Config in production; env map shown for clarity.
 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Single-client config assembled from flat env vars. */
function buildConfig(): ClientConfig {
  const provider = (process.env.SMS_PROVIDER ?? "ghl") as ClientConfig["sms"]["provider"];
  const sms: ClientConfig["sms"] = { provider };
  if (provider === "twilio") {
    sms.twilio = {
      accountSid: requireEnv("TWILIO_ACCOUNT_SID"),
      authToken: requireEnv("TWILIO_AUTH_TOKEN"),
      from: requireEnv("TWILIO_FROM"),
    };
  } else if (provider === "telnyx") {
    sms.telnyx = {
      apiKey: requireEnv("TELNYX_API_KEY"),
      from: requireEnv("TELNYX_FROM"),
      messagingProfileId: process.env.TELNYX_MESSAGING_PROFILE_ID,
    };
  }
  return {
    assistantId: requireEnv("VAPI_ASSISTANT_ID"),
    pit: requireEnv("GHL_PIT"),
    calendarId: requireEnv("GHL_CALENDAR_ID"),
    locationId: requireEnv("GHL_LOCATION_ID"),
    assignedUserId: process.env.GHL_ASSIGNED_USER_ID || undefined,
    timezone: process.env.GHL_TIMEZONE ?? "America/New_York",
    closures: {
      weekendDays: (process.env.CLOSURE_WEEKEND_DAYS ?? "0,6")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n)),
      holidays: (process.env.CLOSURE_HOLIDAYS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    sms,
  };
}

/** Single client — phoneNumberId is ignored. */
export function getClientConfig(_phoneNumberId?: string): ClientConfig {
  return buildConfig();
}

/** Single client — the inbound number always maps to the one client. */
export function getClientByInbound(_receivingId?: string): ClientConfig {
  return buildConfig();
}

function calHeaders(pit: string) {
  return {
    Authorization: `Bearer ${pit}`,
    Version: "2021-04-15",
    "Content-Type": "application/json",
  };
}

function contactHeaders(pit: string) {
  return {
    Authorization: `Bearer ${pit}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// GHL (LeadConnector) response shapes.
//
// Hand-written instead of pulling the official @gohighlevel/api-client SDK: this
// function bundle has a ZERO runtime-dependency rule (cold-start budget on the
// 7.5s assistant-request path). These cover only the fields the code reads; the
// `[k: string]: unknown` index signature keeps the rest accessible without lying
// about exhaustiveness. Verified against live payloads on 2026-06-29.
// ---------------------------------------------------------------------------

/** A GHL contact as returned by upsert / search-duplicate. */
export interface GhlContact {
  id: string;
  firstName?: string;
  lastName?: string;
  /** Some endpoints return a combined name field instead of first/last. */
  contactName?: string;
  name?: string;
  email?: string;
  phone?: string;
  locationId?: string;
  [k: string]: unknown;
}

/** A GHL calendar appointment/event. NOTE: the /contacts/{id}/appointments
 *  endpoint returns `startTime` as an OFFSET-LESS, calendar-local string
 *  ("2026-06-29 15:00:00") — normalize with zonedToIso() before any time math. */
export interface GhlAppointment {
  id: string;
  startTime?: string;
  endTime?: string;
  title?: string;
  appointmentStatus?: string;
  assignedUserId?: string;
  calendarId?: string;
  contactId?: string;
  [k: string]: unknown;
}

/** free-slots: keyed by "YYYY-MM-DD" -> { slots }, plus a stray `traceId` string. */
type GhlFreeSlotsDay = { slots?: string[] };
type GhlFreeSlotsResponse = Record<string, GhlFreeSlotsDay | string | undefined>;

interface GhlUpsertResponse {
  new?: boolean;
  contact?: GhlContact;
  id?: string;
  traceId?: string;
}
interface GhlDuplicateSearchResponse {
  contact?: GhlContact | null;
}
interface GhlAppointmentsResponse {
  events?: GhlAppointment[];
  appointments?: GhlAppointment[];
}
interface GhlNoteResponse {
  note?: { id?: string; body?: string; [k: string]: unknown };
}

/** Free slots between two instants. startDate/endDate are EPOCH MILLISECONDS. */
export async function getFreeSlots(
  cfg: ClientConfig,
  startMs: number,
  endMs: number
): Promise<Record<string, string[]>> {
  const url =
    `${GHL_BASE}/calendars/${cfg.calendarId}/free-slots` +
    `?startDate=${startMs}&endDate=${endMs}&timezone=${encodeURIComponent(cfg.timezone)}`;

  const res = await fetch(url, { headers: calHeaders(cfg.pit) });
  if (!res.ok) throw new Error(`free-slots ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as GhlFreeSlotsResponse;

  // Response is keyed by date string -> { slots: [...] }, plus a traceId we skip.
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && Array.isArray(v.slots)) out[k] = v.slots;
  }
  return out;
}

/** Upsert a contact by phone (caller ID). Returns the contactId. */
export async function upsertContactByPhone(
  cfg: ClientConfig,
  phone: string,
  extra?: { name?: string; email?: string }
): Promise<string | null> {
  if (!phone) return null;
  const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method: "POST",
    headers: contactHeaders(cfg.pit),
    body: JSON.stringify({ locationId: cfg.locationId, phone, ...extra }),
  });
  if (!res.ok) throw new Error(`upsert ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as GhlUpsertResponse;
  return data?.contact?.id ?? data?.id ?? null;
}

/** Create the appointment. startTime is offset-aware ISO 8601. */
export async function createAppointment(
  cfg: ClientConfig,
  contactId: string,
  startTime: string,
  title = "Appointment"
): Promise<GhlAppointment> {
  const res = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
    method: "POST",
    headers: calHeaders(cfg.pit),
    body: JSON.stringify({
      calendarId: cfg.calendarId,
      locationId: cfg.locationId,
      contactId,
      startTime,
      timezone: cfg.timezone,
      title,
      // Only sent when configured — drives which user's Google calendar it syncs to.
      ...(cfg.assignedUserId ? { assignedUserId: cfg.assignedUserId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`create-appointment ${res.status}: ${await res.text()}`);
  return (await res.json()) as GhlAppointment;
}

/** Move an existing appointment to a new time (reschedule). Keeps the same record. */
export async function updateAppointment(
  cfg: ClientConfig,
  appointmentId: string,
  startTime: string
): Promise<GhlAppointment> {
  const res = await fetch(
    `${GHL_BASE}/calendars/events/appointments/${appointmentId}`,
    {
      method: "PUT",
      headers: calHeaders(cfg.pit),
      body: JSON.stringify({ startTime, timezone: cfg.timezone }),
    }
  );
  if (!res.ok) throw new Error(`update-appointment ${res.status}: ${await res.text()}`);
  return (await res.json()) as GhlAppointment;
}

export interface KnownContact {
  id: string;
  name?: string;
  email?: string;
}

/**
 * READ-ONLY lookup by phone. Returns the existing contact or null — does NOT
 * create one. This is what runs at call start so we never pollute the CRM with
 * a contact for every inbound call.
 */
export async function getContactByPhone(
  cfg: ClientConfig,
  phone: string
): Promise<KnownContact | null> {
  if (!phone) return null;
  const url =
    `${GHL_BASE}/contacts/search/duplicate` +
    `?locationId=${cfg.locationId}&number=${encodeURIComponent(phone)}`;
  const res = await fetch(url, { headers: contactHeaders(cfg.pit) });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`dup-search ${res.status}: ${await res.text()}`);
  }
  const c = ((await res.json()) as GhlDuplicateSearchResponse)?.contact;
  if (!c?.id) return null;
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName;
  return { id: c.id, name, email: c.email };
}

/** Backfill the email (or any field) onto an existing contact. */
export async function updateContact(
  cfg: ClientConfig,
  contactId: string,
  patch: { email?: string; name?: string }
): Promise<void> {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: "PUT",
    headers: contactHeaders(cfg.pit),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update-contact ${res.status}: ${await res.text()}`);
}

/** Add a note to a contact (e.g. the AI call summary). Notes append, so each call
 *  keeps its own history entry. userId sets the note author when configured. */
export async function createNote(
  cfg: ClientConfig,
  contactId: string,
  body: string
): Promise<GhlNoteResponse> {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
    method: "POST",
    headers: contactHeaders(cfg.pit),
    body: JSON.stringify({ body, ...(cfg.assignedUserId ? { userId: cfg.assignedUserId } : {}) }),
  });
  if (!res.ok) throw new Error(`create-note ${res.status}: ${await res.text()}`);
  return (await res.json()) as GhlNoteResponse;
}

export interface UpcomingAppt {
  id: string;
  startTime: string;
  title?: string;
}

const DEAD_STATUSES = new Set(["cancelled", "invalid", "noshow", "no-show", "no_show"]);

/**
 * Soonest FUTURE, non-cancelled appointment for a contact, or null. Used to
 * offer a reschedule instead of silently double-booking a known caller.
 */
export async function getUpcomingAppointment(
  cfg: ClientConfig,
  contactId: string
): Promise<UpcomingAppt | null> {
  if (!contactId) return null;
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/appointments`, {
    headers: contactHeaders(cfg.pit),
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`contact-appointments ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as GhlAppointmentsResponse;
  const list: GhlAppointment[] = data?.events ?? data?.appointments ?? [];
  const now = Date.now();
  // The appointments endpoint returns offset-LESS, calendar-local startTimes.
  // Normalize to a real instant in cfg.timezone before any time math, otherwise the
  // server tz (UTC on Vercel) silently shifts every comparison by hours.
  const upcoming = list
    .map((a) => ({ ...a, _iso: a.startTime ? zonedToIso(String(a.startTime), cfg.timezone) : "" }))
    .filter(
      (a) =>
        a._iso &&
        Date.parse(a._iso) > now &&
        !DEAD_STATUSES.has(String(a.appointmentStatus ?? "").toLowerCase())
    )
    .sort((a, b) => Date.parse(a._iso) - Date.parse(b._iso));
  const a = upcoming[0];
  return a ? { id: a.id, startTime: a._iso, title: a.title } : null;
}
