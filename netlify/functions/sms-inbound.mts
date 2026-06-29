// netlify/functions/sms-inbound.mts
// Netlify adapter for the inbound-SMS webhook (Twilio / Telnyx / GHL) → email
// backfill. Logic lives in ../../api/sms-inbound.ts (shared with Vercel).
import { POST } from "../../api/sms-inbound.js";

export default (req: Request): Promise<Response> => POST(req);

export const config = { path: "/api/sms-inbound" };
