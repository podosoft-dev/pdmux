// Dev/test SMS sink — the "Mailpit for SMS". The app posts outgoing SMS here
// (via SMS_WEBHOOK_URL) instead of a real provider, and tests read them back
// over REST. It also captures any request posted to /hooks/<name> (for example
// operator-notification webhooks and a Pushover stand-in) for GET /hooks.
// Development only; never runs in production (see the `dev` profile in
// docker-compose.yml). It uses Bun-compatible standard library APIs and runs
// on the same pinned Bun Alpine runtime as generated applications.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8095);
/** @type {{to: string, body: string, receivedAt: string}[]} */
let messages = [];
/** @type {{name: string, contentType: string, body: string, receivedAt: string}[]} */
let hooks = [];
const MAX_HOOKS = 200;

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const { method, url } = req;
  if (method === "GET" && url === "/readyz") return send(res, 200, { status: "ok" });
  if (method === "GET" && url === "/messages") return send(res, 200, messages);
  if (method === "DELETE" && url === "/messages") {
    messages = [];
    return send(res, 200, { cleared: true });
  }
  if (method === "GET" && url === "/hooks") return send(res, 200, hooks);
  if (method === "DELETE" && url === "/hooks") {
    hooks = [];
    return send(res, 200, { cleared: true });
  }
  if (method === "POST" && url?.startsWith("/hooks/")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const name = url.slice("/hooks/".length);
      hooks.unshift({ name, contentType: req.headers["content-type"] ?? "", body: raw, receivedAt: new Date().toISOString() });
      hooks = hooks.slice(0, MAX_HOOKS);
      // Pushover answers {"status":1}; any 2xx JSON satisfies a generic webhook.
      send(res, 200, { status: 1 });
    });
    return;
  }
  if (method === "POST" && url === "/sms") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let payload = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = { body: raw };
      }
      messages.unshift({ to: payload.to ?? payload.phoneNumber ?? "", body: payload.body ?? payload.code ?? raw, receivedAt: new Date().toISOString() });
      send(res, 202, { accepted: true });
    });
    return;
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log(`[sms-sink] listening on ${PORT}`));
