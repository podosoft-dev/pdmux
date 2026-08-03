// Dev/test SMS sink — the "Mailpit for SMS". The app posts outgoing SMS here
// (via SMS_WEBHOOK_URL) instead of a real provider, and tests read them back
// over REST. Development only; never runs in production (see the `dev` profile
// in docker-compose.yml). Uses only Node built-ins, run on a stock node image.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8095);
/** @type {{to: string, body: string, receivedAt: string}[]} */
let messages = [];

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
