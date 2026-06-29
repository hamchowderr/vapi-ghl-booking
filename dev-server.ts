// Local test runner — serves the same /api handlers vercel dev would, but reads
// .env.local directly (vercel dev pulls env from the cloud project, which is empty
// for local-only testing). Run: npx --yes tsx dev-server.ts   (PORT defaults to 3000)
// This is a LOCAL TEST HARNESS only — production runs on Vercel Functions.
import "./dev-load-env"; // MUST be first: populate process.env from .env.local before handler/cache modules evaluate
import { createServer } from "node:http";

import { POST as assistantRequest } from "./api/assistant-request";
import { POST as checkAvailability } from "./api/check-availability";
import { POST as calendarBooking } from "./api/calendar-booking";
import { POST as smsInbound } from "./api/sms-inbound";
import { POST as callReport } from "./api/call-report";

const routes: Record<string, (r: Request) => Promise<Response>> = {
  "/api/assistant-request": assistantRequest,
  "/api/check-availability": checkAvailability,
  "/api/calendar-booking": calendarBooking,
  "/api/sms-inbound": smsInbound,
  "/api/call-report": callReport,
};

const PORT = Number(process.env.PORT) || 3000;

createServer(async (req, res) => {
  const path = (req.url || "").split("?")[0];
  const handler = routes[path];
  const ts = new Date().toISOString();
  if (!handler) { res.writeHead(404); res.end("not found"); return; }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const request = new Request("http://localhost" + req.url, {
    method: req.method,
    headers: req.headers as any,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  try {
    const response = await handler(request);
    const buf = Buffer.from(await response.arrayBuffer());
    console.log(`${ts}  ${req.method} ${path} -> ${response.status}`);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(buf);
  } catch (e) {
    console.error(`${ts}  ${req.method} ${path} -> 500`, e);
    res.writeHead(500); res.end("error");
  }
}).listen(PORT, () => console.log(`dev-server listening on http://localhost:${PORT}`));
