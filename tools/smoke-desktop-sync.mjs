import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createServer } from "node:https";
import { request as upstream } from "node:http";
import { StackManager } from "../apps/desktop/src/stack-manager.ts";

if (!process.env.PDMUX_SYNC_FIXTURE) {
  const root = await mkdtemp(join(tmpdir(), "pdmux-desktop-sync-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-addext", "basicConstraints=critical,CA:TRUE"], { stdio: "ignore" });
    const code = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [import.meta.filename], { stdio: "inherit", timeout: 180_000, env: { ...process.env, PDMUX_SYNC_FIXTURE: root, NODE_EXTRA_CA_CERTS: join(root, "cert.pem") } });
      child.once("error", reject); child.once("exit", accept);
    });
    assert.equal(code, 0, "Isolated desktop synchronization smoke failed");
  } finally { await rm(root, { recursive: true, force: true }); }
} else {
  const root = process.env.PDMUX_SYNC_FIXTURE;
  const repository = resolve(import.meta.dirname, "..");
  const layout = name => {
    const data = join(root, name);
    return { bunExecutable: process.execPath, apiEntry: join(repository, name === "local" ? "apps/api/dist-desktop/main.js" : "apps/api/dist/main.js"), migrateEntry: join(repository, name === "local" ? "apps/api/dist-desktop/desktop-migrate.js" : "apps/api/dist/desktop-migrate.js"), webEntry: join(repository, name === "local" ? "apps/web/build-desktop/index.js" : "apps/web/build/index.js"), dataDirectory: data, filesDirectory: join(data, "files"), databasePath: join(data, "pdmux.sqlite"), secretPath: join(data, "auth.secret"), agentReleaseDirectory: join(repository, "apps/web/build/client/agent") };
  };
  let serverUrl; let tlsOrigin;
  const sockets = new Set();
  const gateway = createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, (request, response) => {
    const path = request.url.startsWith("/api/auth") ? request.url : request.url.replace(/^\/api\//, "/");
    const remote = upstream(new URL(path, serverUrl), { method: request.method, headers: { ...request.headers, host: new URL(serverUrl).host } }, received => {
      response.writeHead(received.statusCode, received.headers); received.pipe(response);
    });
    remote.on("error", () => response.destroy()); request.pipe(remote);
  });
  gateway.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  gateway.on("upgrade", (request, socket, head) => {
    const remote = upstream(new URL(request.url, serverUrl), { headers: { ...request.headers, host: new URL(serverUrl).host } });
    remote.on("upgrade", (response, peer, extra) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) peer.write(head); if (extra.length) socket.write(extra);
      socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
      socket.on("close", () => peer.destroy()); peer.on("close", () => socket.destroy()); socket.pipe(peer).pipe(socket);
    });
    remote.on("response", response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\n\r\n`); response.resume(); });
    remote.on("error", () => socket.destroy()); remote.end();
  });
  await new Promise(accept => gateway.listen(0, "127.0.0.1", accept));
  tlsOrigin = `https://127.0.0.1:${gateway.address().port}`;
  const server = new StackManager(layout("server"), { spawn: (command, args, options) => spawn(command, [...args], { ...options, env: { ...options.env, PDMUX_DESKTOP_RUNTIME: "0", CORS_ORIGIN: tlsOrigin, ADMIN_EMAILS: "desktop-smoke@example.test" } }) });
  const local = new StackManager(layout("local"));
  let agent;
  let fileFixture;
  async function json(origin, path, cookie, method = "GET", body) {
    const response = await fetch(`${origin}${path}`, { method, headers: { cookie, "content-type": "application/json", ...(origin === tlsOrigin || path.startsWith("/api/auth/") ? { origin: tlsOrigin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      let code = "unknown"; try { const data = await response.json(); code = data.error?.code ?? data.code ?? code; } catch { /* Empty failure. */ }
      throw new Error(`${method} ${path}: ${response.status} ${code}`);
    }
    return response.json();
  }
  try {
    serverUrl = (await server.start()).apiUrl;
    const signup = await fetch(`${serverUrl}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Desktop smoke", email: "desktop-smoke@example.test", password: "Isolated-Desktop-42!password" }) });
    assert.equal(signup.status, 200);
    const cloudCookie = signup.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    assert.ok(cloudCookie);
    const organization = await json(serverUrl, "/api/auth/organization/create", cloudCookie, "POST", { name: "Desktop test workspace", slug: `desktop-test-${crypto.randomUUID()}` });
    const remoteHost = await json(serverUrl, "/hosts", cloudCookie, "POST", { label: "server-owned" });
    const localUrl = (await local.start()).apiUrl;
    const login = await local.localSession();
    const localCookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    await local.control("attach");
    const localHost = await json(localUrl, "/hosts", localCookie, "POST", { label: "desktop-owned" });
    await json(localUrl, `/hosts/${localHost.id}/services`, localCookie, "POST", { label: "HTTP", port: 8080 });
    await json(serverUrl, "/prefs/layouts/default", cloudCookie, "PUT", { payload: { mode: "one", slots: [] }, isDefault: true });
    await json(localUrl, "/prefs/layouts/default", localCookie, "PUT", { payload: { mode: "split2", slots: [{ id: "slot-1", hostId: localHost.id, kind: "attach", session: "test" }] }, isDefault: true });
    await local.control("connect", { url: tlsOrigin, cookie: cloudCookie });
    const initialStatus = await json(localUrl, "/desktop/status", localCookie);
    assert.ok(initialStatus.conflicts.some(item => item.key === "layout:default"));
    await json(localUrl, "/desktop/resolve", localCookie, "POST", { key: "layout:default", choice: "local" });
    await new Promise(resolve => setTimeout(resolve, 150));
    const cloudHosts = await json(serverUrl, "/hosts", cloudCookie);
    const mirror = cloudHosts.find(host => host.label === "desktop-owned");
    assert.ok(mirror, "Publish desktop hosts to the web workspace");
    const syncedPrefs = await json(serverUrl, "/prefs", cloudCookie);
    assert.equal(syncedPrefs.layouts.find(row => row.name === "default").payload.slots[0].hostId, mirror.id);
    const onDesktop = await json(localUrl, "/hosts", localCookie);
    assert.ok(onDesktop.some(host => host.label === "server-owned"), "Import server host metadata");
    await json(serverUrl, `/hosts/${mirror.id}`, cloudCookie, "PATCH", { description: "changed-from-web" });
    assert.equal((await json(localUrl, `/hosts/${localHost.id}`, localCookie)).description, "changed-from-web");
    const remoteOnDesktop = onDesktop.find(host => host.label === "server-owned");
    await json(localUrl, `/hosts/${remoteOnDesktop.id}`, localCookie, "PATCH", { description: "changed-from-desktop" });
    assert.equal((await json(serverUrl, `/hosts/${remoteHost.id}`, cloudCookie)).description, "changed-from-desktop");
    const services = await json(serverUrl, `/hosts/${mirror.id}/services`, cloudCookie);
    assert.equal(services.length, 1);
    const refused = await fetch(`${serverUrl}/hosts/${mirror.id}/tokens`, { method: "POST", headers: { cookie: cloudCookie, "content-type": "application/json" }, body: "{}" });
    assert.equal(refused.status, 403, "Never mint duplicate credentials for a linked host");
    if (process.platform === "darwin") {
      const enrolled = await json(localUrl, "/agent/enroll", "", "POST", { code: localHost.enrollment.code, hostname: "desktop-sync-test" });
      const config = join(root, "agent.json");
      await writeFile(config, JSON.stringify({ server: localUrl, token: enrolled.token, hostname: "desktop-sync-test", logLevel: "error" }), { mode: 0o600 });
      const privateTmux = join(root, "tmux"); await mkdir(privateTmux, { mode: 0o700 });
      const agentEnv = { ...process.env, PDMUX_CONFIG: config, PDMUX_STATE_DIR: join(root, "agent-state"), TMUX_TMPDIR: privateTmux };
      delete agentEnv.TMUX; delete agentEnv.PDMUX_TOKEN; delete agentEnv.PDMUX_SERVER;
      const binary = join(repository, "apps/web/static/agent/0.1.27/pdmux-agent-darwin-arm64");
      agent = spawn(binary, ["run"], { env: agentEnv, stdio: "ignore" });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if ((await json(localUrl, `/hosts/${localHost.id}`, localCookie)).connected) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal((await json(localUrl, `/hosts/${localHost.id}`, localCookie)).connected, true);
      const cacheRoot = join(homedir(), ".cache/pdmux"); await mkdir(cacheRoot, { recursive: true });
      fileFixture = await mkdtemp(join(cacheRoot, "desktop-relay-test-"));
      const relative = fileFixture.slice(homedir().length + 1) + "/fixture.json";
      const contents = JSON.stringify({ hostId: localHost.id, data: "x".repeat(512_000) });
      const uploaded = await fetch(`${serverUrl}/hosts/${mirror.id}/files/upload?${new URLSearchParams({ path: relative })}`, { method: "POST", headers: { cookie: cloudCookie, "content-type": "application/octet-stream" }, body: contents });
      assert.equal(uploaded.status, 200);
      const downloaded = await fetch(`${serverUrl}/hosts/${mirror.id}/files/download?${new URLSearchParams({ path: relative })}`, { headers: { cookie: cloudCookie } });
      assert.equal(downloaded.status, 200);
      assert.equal(await downloaded.text(), contents, "Keep file bytes unchanged through the relay");
      const terminal = new WebSocket(`${tlsOrigin.replace(/^https/, "wss")}/terminal/ws?hostId=${mirror.id}`, { headers: { cookie: cloudCookie, origin: tlsOrigin } });
      let output = "";
      await new Promise((accept, reject) => {
        const timeout = setTimeout(() => { terminal.close(); reject(new Error("Relayed terminal timed out")); }, 15_000);
        terminal.addEventListener("open", () => terminal.send(JSON.stringify({ type: "open", termId: "relay-smoke", target: { kind: "shell", cols: 80, rows: 24 } })));
        terminal.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Relayed terminal failed")); });
        terminal.addEventListener("message", event => {
          const frame = JSON.parse(event.data);
          if (frame.type === "ready") terminal.send(JSON.stringify({ type: "input", termId: "relay-smoke", data: "printf 'PDMUX_RELAY_%s\\n' OK\n" }));
          if (frame.type === "output") output += frame.data;
          if (output.includes("PDMUX_RELAY_OK")) { clearTimeout(timeout); terminal.close(); accept(); }
        });
      });
    }
    await local.control("disconnect");
    const cached = await json(localUrl, "/hosts", localCookie);
    assert.ok(cached.some(host => host.label === "server-owned" && host.origin.readOnly), "Keep a read-only server list after disconnect");
    await json(localUrl, `/hosts/${localHost.id}`, localCookie, "PATCH", { description: "still-local" });
    const unavailable = await fetch(`${serverUrl}/hosts/${mirror.id}/collect`, { method: "POST", headers: { cookie: cloudCookie } });
    assert.equal(unavailable.status, 503);
    if (process.env.PDMUX_NATIVE_AUTH_BUNDLE) {
      await new Promise((accept, reject) => {
        const child = spawn("node", [join(repository, "tools/smoke-desktop-auth.mjs")], { stdio: ["pipe", "inherit", "inherit"], env: process.env, timeout: 120_000 });
        child.stdin.end(JSON.stringify({ url: tlsOrigin, cookie: cloudCookie, workspaceId: organization.id, profile: join(root, "native-auth"), bundle: process.env.PDMUX_NATIVE_AUTH_BUNDLE }));
        child.once("error", reject); child.once("exit", code => code === 0 ? accept() : reject(new Error("Native PKCE smoke failed")));
      });
    }
    console.log(JSON.stringify({ stage: "desktop-server-sync", result: "passed", directions: 2, logoutCache: true }));
  } finally {
    if (agent && agent.exitCode === null) { agent.kill("SIGTERM"); await new Promise(accept => agent.once("exit", accept)); }
    if (fileFixture) await rm(fileFixture, { recursive: true, force: true });
    await local.stop(); await server.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(accept => gateway.close(accept));
  }
}
