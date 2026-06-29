// Side-effect module imported FIRST by dev-server.ts so .env.local is in
// process.env BEFORE any handler/lib module (e.g. lib/cache.ts, which reads the
// Redis URL at module-eval time) is imported. ESM evaluates imports in order,
// so importing this before the ./api/* handlers guarantees env is populated.
//
// .env.local is AUTHORITATIVE for local dev: it OVERRIDES any inherited shell
// env var. The launching shell can carry stale/foreign values for these same
// keys (e.g. a different GHL_PIT exported elsewhere); deferring to those caused
// silent 401s. For a local runner, the file on disk is the source of truth.
import { readFileSync } from "node:fs";

for (const raw of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const s = raw.trim();
  if (!s || s.startsWith("#") || !s.includes("=")) continue;
  const i = s.indexOf("=");
  const key = s.slice(0, i).trim();
  const val = s.slice(i + 1).replace(/\s+#.*$/, "").trim(); // strip inline " # comment"
  if (key) process.env[key] = val; // .env.local wins, even over an inherited value
}
