import { resolve } from "node:path";
// Ship only the Electron client's reachable code, rather than the auth server SDK
// and its optional database adapters in the native application's node_modules.
const root = resolve(import.meta.dirname, "..");
const result = await Bun.build({ entrypoints: [resolve(root, "src/cloud-connection.ts")], outdir: resolve(root, "dist"), target: "node", format: "esm", external: ["electron"], minify: { whitespace: true, syntax: true, identifiers: false } });
if (!result.success) throw new AggregateError(result.logs, "Bundle desktop authentication failed");
console.log(JSON.stringify({ stage: "desktop-auth-build", bytes: result.outputs.reduce((total, file) => total + file.size, 0) }));
