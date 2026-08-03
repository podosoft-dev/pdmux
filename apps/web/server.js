/**
 * The production entry point: adapter-node's server plus the terminal upgrade.
 *
 * `node build` (adapter-node's own entry) serves HTTP perfectly well and drops every
 * WebSocket upgrade into SvelteKit, which cannot answer one — so terminals worked in
 * development (Vite proxied the upgrade) and were dead in every built deployment.
 * This entry keeps adapter-node in charge of listening, graceful shutdown and the
 * PORT/HOST/IDLE_TIMEOUT contract, and adds the one thing it cannot do.
 *
 * ⚠ It is not type-checked: it imports `./build/`, which only exists after
 * `npm run build`, and `npm run lint` must not depend on a build. Everything with a
 * decision in it therefore lives in `src/lib/server/terminal-upgrade.js`, which is
 * checked and unit-tested; what is left here is wiring.
 */
import { server } from "./build/index.js";
import { proxyTerminalUpgrade } from "./src/lib/server/terminal-upgrade.js";

// polka exposes the http.Server it was handed. If a future adapter stops doing so,
// fail at boot: silently serving without terminals is the bug this entry exists for.
const httpServer = server.server;
if (!httpServer || typeof httpServer.on !== "function") {
  throw new Error("adapter-node did not expose its HTTP server; the terminal upgrade proxy cannot be mounted");
}

httpServer.on("upgrade", proxyTerminalUpgrade);
console.log("Terminal upgrade proxy mounted");
