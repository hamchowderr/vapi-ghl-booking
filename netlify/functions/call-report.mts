// netlify/functions/call-report.mts
// Netlify adapter for the `end-of-call-report` webhook → writes the AI summary as
// a Note on the caller's contact. Logic lives in ../../api/call-report.ts.
import { POST } from "../../api/call-report.js";

export default (req: Request): Promise<Response> => POST(req);

export const config = { path: "/api/call-report" };
