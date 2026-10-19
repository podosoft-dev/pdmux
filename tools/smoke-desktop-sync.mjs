import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createServer } from "node:https";
import { request as upstream } from "node:http";
import { StackManager } from "../apps/desktop/src/stack-manager.ts";
import { parseAgentVersion } from "../apps/desktop/src/staging.ts";

if (!process.env.PDMUX_SYNC_FIXTURE) {
  // macOS Unix sockets allow short paths; its default per-user tmpdir is too
  // long once the private tmux socket name is appended.
  const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "pdmux-desktop-sync-"));
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
  const agentVersion = parseAgentVersion(await readFile(join(repository, "agent/internal/cli/version.go"), "utf8"));
  const agentBinary = process.env.PDMUX_SYNC_AGENT_BINARY ?? join(repository, `apps/web/static/agent/${agentVersion}/pdmux-agent-darwin-${process.arch === "arm64" ? "arm64" : "amd64"}`);
  const layout = name => {
    const data = join(root, name);
    return { bunExecutable: process.execPath, apiEntry: join(repository, name === "local" ? "apps/api/dist-desktop/main.js" : "apps/api/dist/main.js"), migrateEntry: join(repository, name === "local" ? "apps/api/dist-desktop/desktop-migrate.js" : "apps/api/dist/desktop-migrate.js"), webEntry: join(repository, name === "local" ? "apps/web/build-desktop/index.js" : "apps/web/build/index.js"), dataDirectory: data, filesDirectory: join(data, "files"), databasePath: join(data, "pdmux.sqlite"), secretPath: join(data, "auth.secret"), agentReleaseDirectory: join(repository, "apps/web/build/client/agent") };
  };
  let serverUrl; let serverWebUrl; let tlsOrigin; let outageMode = false;
  const sockets = new Set();
  const gateway = createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, (request, response) => {
    if (outageMode) { response.writeHead(503); response.end(); return; }
    const path = request.url.startsWith("/api/auth") ? request.url : request.url.replace(/^\/api\//, "/");
    const origin = request.url.startsWith("/api/") ? serverUrl : serverWebUrl;
    const remote = upstream(new URL(path, origin), { method: request.method, headers: { ...request.headers, host: new URL(origin).host } }, received => {
      response.writeHead(received.statusCode, received.headers); received.pipe(response);
    });
    remote.on("error", () => response.destroy()); request.pipe(remote);
  });
  gateway.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  gateway.on("upgrade", (request, socket, head) => {
    if (outageMode) { socket.end("HTTP/1.1 503 Unavailable\r\n\r\n"); return; }
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
  // A production API refuses ADMIN_EMAILS placeholders on documentation domains such as
  // example.test. This isolated stack sends no mail, and `.internal` is reserved for
  // private networks, so the address cannot belong to anybody.
  const smokeAccount = { name: "Desktop smoke", email: "desktop-smoke@pdmux-smoke.internal", password: "Isolated-Desktop-42!password" };
  const personalWorkspace = process.env.PDMUX_RESIZE_UI === "1";
  const serverLayout = layout("server");
  // PodoKit refuses a sign-up for an ADMIN_EMAILS address that has not proven it, so the
  // workspace administrator is created with admin:bootstrap between the server's
  // migration and its start, as on a real install. The personal-workspace probe keeps
  // ADMIN_EMAILS empty and signs up instead.
  const bootstrapAfterMigration = (migration, env) => {
    const chained = Object.assign(new EventEmitter(), { exitCode: null, stdin: null, kill: signal => current.kill(signal) });
    let current = migration;
    const finish = code => { chained.exitCode = code; chained.emit("exit", code); };
    migration.once("exit", code => {
      if (code !== 0) { finish(code); return; }
      current = spawn(process.execPath, [join(repository, "apps/api/scripts/bootstrap-admin.mjs")], {
        cwd: join(repository, "apps/api"), stdio: "inherit",
        env: { ...env, ADMIN_BOOTSTRAP_EMAIL: smokeAccount.email, ADMIN_BOOTSTRAP_PASSWORD: smokeAccount.password, ADMIN_BOOTSTRAP_NAME: smokeAccount.name },
      });
      current.once("exit", finish);
    });
    return chained;
  };
  const server = new StackManager(serverLayout, { spawn: (command, args, options) => {
    const env = { ...options.env, PDMUX_DESKTOP_RUNTIME: "0", CORS_ORIGIN: tlsOrigin, ADMIN_EMAILS: personalWorkspace ? "" : smokeAccount.email };
    const child = spawn(command, [...args], { ...options, env });
    return !personalWorkspace && args[0] === serverLayout.migrateEntry ? bootstrapAfterMigration(child, env) : child;
  } });
  const local = new StackManager(layout("local"));
  let agent;
  let serverAgent;
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
    const started = await server.start(); serverUrl = started.apiUrl; serverWebUrl = started.webUrl;
    const signIn = personalWorkspace
      ? await fetch(`${serverUrl}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(smokeAccount) })
      : await fetch(`${serverUrl}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: smokeAccount.email, password: smokeAccount.password }) });
    assert.equal(signIn.status, 200, "Sign in to the isolated server stack");
    const cloudCookie = signIn.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    assert.ok(cloudCookie);
    const organization = personalWorkspace
      ? { id: `personal:${(await signIn.json()).user.id}` }
      : await json(serverUrl, "/api/auth/organization/create", cloudCookie, "POST", { name: "Desktop test workspace", slug: `desktop-test-${crypto.randomUUID()}` });
    const remoteHost = await json(serverUrl, "/hosts", cloudCookie, "POST", { label: "server-owned" });
    const localUrl = (await local.start()).apiUrl;
    const login = await local.localSession();
    const localCookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    await local.control("attach");
    const disconnectedSettings = await fetch(`${localUrl}/desktop/server/fleet/settings`, { headers: { cookie: localCookie } });
    assert.equal(disconnectedSettings.status, 409, "[TC-PDDESKTOP-020] server settings require a live connection");
    await json(localUrl, "/fleet/settings", localCookie, "PUT", { heartbeatSec: 7 });
    await json(serverUrl, "/fleet/settings", cloudCookie, "PUT", { heartbeatSec: 11 });

    const localHost = await json(localUrl, "/hosts", localCookie, "POST", { label: "desktop-owned" });
    await json(localUrl, `/hosts/${localHost.id}/services`, localCookie, "POST", { label: "HTTP", port: 8080 });
    await json(serverUrl, "/prefs/layouts/default", cloudCookie, "PUT", { payload: { mode: "one", slots: [] }, isDefault: true });
    await json(localUrl, "/prefs/layouts/default", localCookie, "PUT", { payload: { mode: "split2", slots: [{ id: "slot-1", hostId: localHost.id, kind: "attach", session: "test" }] }, isDefault: true });
    await local.control("connect", { url: tlsOrigin, cookie: cloudCookie });
    const initialStatus = await json(localUrl, "/desktop/status", localCookie);
    const remoteSettings = await json(localUrl, "/desktop/server/fleet/settings", localCookie);
    assert.equal(remoteSettings.heartbeatSec, 11, "[TC-PDDESKTOP-020] read the server's settings");
    await json(localUrl, "/desktop/server/fleet/settings", localCookie, "PUT", { heartbeatSec: 13 });
    assert.equal((await json(serverUrl, "/fleet/settings", cloudCookie)).heartbeatSec, 13);
    assert.equal((await json(localUrl, "/fleet/settings", localCookie)).heartbeatSec, 7, "[TC-PDDESKTOP-020] server edits never overwrite local settings");
    assert.equal((await json(localUrl, "/desktop/server/fleet/scope", localCookie)).canManage, true);
    assert.ok(Array.isArray(await json(localUrl, "/desktop/server/hosts", localCookie)));
    const anonymousSettings = await fetch(`${localUrl}/desktop/server/fleet/settings`);
    assert.equal(anonymousSettings.status, 401);
    const unknownSettings = await fetch(`${localUrl}/desktop/server/account/settings`, { headers: { cookie: localCookie } });
    assert.equal(unknownSettings.status, 403, "[TC-PDDESKTOP-020] no arbitrary server proxy");

    assert.ok(initialStatus.conflicts.some(item => item.key === "layout:default"));
    await json(localUrl, "/desktop/resolve", localCookie, "POST", { key: "layout:default", choice: "local" });
    await new Promise(resolve => setTimeout(resolve, 150));
    const cloudHosts = await json(serverUrl, "/hosts", cloudCookie);
    const mirror = cloudHosts.find(host => host.label === "desktop-owned");
    assert.ok(mirror, "Publish desktop hosts to the web workspace");
    await json(localUrl, `/hosts/${localHost.id}`, localCookie, "PATCH", { label: "Desktop workstation" });
    assert.equal((await json(serverUrl, `/hosts/${mirror.id}`, cloudCookie)).label, "Desktop workstation", "[TC-PDDESKTOP-017] a local host rename reaches the existing web host");
    await local.control("disconnect");
    await json(localUrl, `/hosts/${localHost.id}`, localCookie, "PATCH", { label: "Renamed workstation" });
    await local.control("connect", { url: tlsOrigin, cookie: cloudCookie });
    // The relay opens after the first metadata sync; a read can still use the offline cache.
    let renamed;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      renamed = await json(serverUrl, `/hosts/${mirror.id}`, cloudCookie);
      if (renamed.label === "Renamed workstation") break;
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert.equal(renamed.label, "Renamed workstation", "[TC-PDDESKTOP-017] a startup rename also synchronizes after reconnecting");
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
      agent = spawn(agentBinary, ["run"], { env: agentEnv, stdio: "ignore" });
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
    if (process.env.PDMUX_RECOVERY_UI === "1" || process.env.PDMUX_RESIZE_UI === "1") {
      assert.equal(process.platform, "darwin", "The native recovery rehearsal uses macOS tmux sessions");
      const enrollment = await json(tlsOrigin, "/api/agent/enroll", "", "POST", { code: remoteHost.enrollment.code, hostname: "recovery-server" });
      const config = join(root, "server-agent.json");
      const tmux = join(root, "server-tmux"); await mkdir(tmux, { mode: 0o700 });
      const agentEnv = { ...process.env, PDMUX_CONFIG: config, PDMUX_STATE_DIR: join(root, "server-agent-state"), TMUX_TMPDIR: tmux };
      delete agentEnv.TMUX; delete agentEnv.PDMUX_TOKEN; delete agentEnv.PDMUX_SERVER;
      const tmuxSocket = join(tmux, `tmux-${process.getuid()}`, "default");
      await mkdir(join(tmux, `tmux-${process.getuid()}`), { mode: 0o700 });
      execFileSync("tmux", ["-S", tmuxSocket, "-f", "/dev/null", "new-session", "-d", "-s", "recovery-fixture"], { env: agentEnv, stdio: "ignore" });
      if (process.env.PDMUX_RESIZE_UI === "1") {
        execFileSync("tmux", ["-S", tmuxSocket, "set-window-option", "-g", "window-size", "smallest"], { env: agentEnv, stdio: "ignore" });
        execFileSync("tmux", ["-S", tmuxSocket, "set-option", "-g", "status", "off"], { env: agentEnv, stdio: "ignore" });
      }
      const tmuxPid = execFileSync("tmux", ["-S", tmuxSocket, "display-message", "-p", "#{pid}"], { env: agentEnv, encoding: "utf8" }).trim();
      const startAgent = async () => {
        // The Go fixture uses the isolated loopback API; TLS is kept on the real
        // browser/desktop path without installing a test CA in the system keychain.
        await writeFile(config, JSON.stringify({ server: serverUrl, token: enrollment.token, hostname: "recovery-server", logLevel: "error" }), { mode: 0o600 });
        serverAgent = spawn(agentBinary, ["run"], { env: agentEnv, stdio: "ignore" });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((await json(serverUrl, `/hosts/${remoteHost.id}`, cloudCookie)).connected) return;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error("Recovery fixture agent did not connect");
      };
      const stopAgent = async () => {
        if (serverAgent && serverAgent.exitCode === null) { serverAgent.kill("SIGTERM"); await new Promise(resolve => serverAgent.once("exit", resolve)); }
      };
      await startAgent();
      await new Promise((accept, reject) => {
        const probe = process.env.PDMUX_RESIZE_UI === "1" ? "smoke-terminal-size-ui.mjs" : "smoke-terminal-recovery-ui.mjs";
        const child = spawn("node", [join(repository, "tools", probe)], { stdio: ["pipe", "inherit", "inherit", "ipc"], env: { ...process.env, PDMUX_BUN_EXECUTABLE: process.execPath }, timeout: 120_000 });
        let serial = Promise.resolve();
        child.on("message", message => {
          serial = serial.then(async () => {
            let facts;
            if (message.action === "outage") {
              outageMode = true;
              for (const socket of sockets) socket.destroy();
              await stopAgent(); await server.stop();
            } else if (message.action === "restore") {
              const restarted = await server.start(); serverUrl = restarted.apiUrl; serverWebUrl = restarted.webUrl;
              outageMode = false;
            } else if (message.action === "agent-online") {
              await startAgent();
              assert.equal(execFileSync("tmux", ["-S", tmuxSocket, "display-message", "-p", "#{pid}"], { env: agentEnv, encoding: "utf8" }).trim(), tmuxPid, "Keep the same private multiplexer server");
            } else if (message.action === "facts") facts = execFileSync("tmux", ["-S", tmuxSocket, "list-panes", "-a", "-F", "#{session_name} #{pane_in_mode} #{pane_current_command}"], { env: agentEnv, encoding: "utf8" }).trim();
            else throw new Error("Unknown recovery fixture action");
            if (child.connected) child.send({ id: message.id, ok: true, facts });
          }).catch(() => { if (child.connected) child.send({ id: message.id, ok: false }); });
        });
        child.stdin.end(JSON.stringify({ url: tlsOrigin, cookie: cloudCookie, workspaceId: organization.id, profile: join(root, "recovery-native"), tmux: join(root, "native-tmux"), serverTmuxSocket: tmuxSocket, output: process.env.PDMUX_RECOVERY_OUTPUT ?? join(repository, "../output/playwright/terminal-recovery") }));
        child.once("error", reject); child.once("exit", code => code === 0 ? accept() : reject(new Error("Terminal recovery UI smoke failed")));
      });
    }
    await local.control("disconnect");
    const closedSettings = await fetch(`${localUrl}/desktop/server/fleet/settings`, { method: "PUT", headers: { cookie: localCookie, "content-type": "application/json" }, body: JSON.stringify({ heartbeatSec: 17 }) });
    assert.equal(closedSettings.status, 409, "[TC-PDDESKTOP-020] disconnect stops server writes");
    assert.equal((await json(serverUrl, "/fleet/settings", cloudCookie)).heartbeatSec, 13);

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
    if (serverAgent && serverAgent.exitCode === null) { serverAgent.kill("SIGTERM"); await new Promise(accept => serverAgent.once("exit", accept)); }
    if (agent && agent.exitCode === null) { agent.kill("SIGTERM"); await new Promise(accept => agent.once("exit", accept)); }
    if (fileFixture) await rm(fileFixture, { recursive: true, force: true });
    await local.stop(); await server.stop();
    if (process.env.PDMUX_RECOVERY_UI === "1" || process.env.PDMUX_RESIZE_UI === "1") {
      for (const name of ["server-tmux", "native-tmux"]) {
        try { execFileSync("tmux", ["-S", join(root, name, `tmux-${process.getuid()}`, "default"), "kill-server"], { stdio: "ignore", env: { ...process.env, TMUX: "" } }); } catch { /* A private server that was never started needs no cleanup. */ }
      }
    }
    for (const socket of sockets) socket.destroy();
    await new Promise(accept => gateway.close(accept));
  }
}
