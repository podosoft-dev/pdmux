import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve, join } from "node:path";
import { desktopRouteExcluded } from "./desktop-build-profile.mjs";

const root = resolve(import.meta.dirname, "../apps/web");
const routes = join(root, "src/routes");
const destination = join(root, ".desktop/routes");
await rm(join(root, ".desktop"), { recursive: true, force: true });
await mkdir(join(root, ".desktop"), { recursive: true });
await cp(routes, destination, { recursive: true, filter: file => !desktopRouteExcluded(relative(routes, file).replaceAll("\\", "/")) });
const layout = join(destination, "+layout.svelte");
await writeFile(layout, (await readFile(layout, "utf8")).replace('"../app.css"', '"../../src/app.css"'));
await cp(join(root, "src/lib/desktop/layout.server.ts"), join(destination, "+layout.server.ts"));
const child = Bun.spawn([process.execPath, "run", "build"], { cwd: root, env: { ...process.env, PDMUX_DESKTOP_BUILD: "1" }, stdout: "inherit", stderr: "inherit" });
if (await child.exited !== 0) throw new Error("Build desktop web failed");
