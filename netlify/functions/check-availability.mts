// netlify/functions/check-availability.mts
// Netlify adapter for the `checkAvailability` tool handler. Logic lives in
// ../../api/check-availability.ts (shared with Vercel); this only re-exports it in
// Netlify's function shape and keeps the /api/* URL stable for VAPI.
import { POST } from "../../api/check-availability.js";

export default (req: Request): Promise<Response> => POST(req);

export const config = { path: "/api/check-availability" };
