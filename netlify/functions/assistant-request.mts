// netlify/functions/assistant-request.mts
// Netlify Functions adapter. ALL booking logic lives in ../../api/* (shared with
// the Vercel deploy) and ../../lib/*. This wrapper only maps Netlify's
// default-export function shape onto the existing Web-standard POST handler and
// pins the public path so the URL is identical to the Vercel route
// (/api/assistant-request) — your VAPI config is unchanged whichever platform you
// deploy to.
import { POST } from "../../api/assistant-request.js";

export default (req: Request): Promise<Response> => POST(req);

// Netlify Functions 2.0 custom routing — preserves the /api/* URL.
// https://docs.netlify.com/functions/get-started/#api-routes
export const config = { path: "/api/assistant-request" };
