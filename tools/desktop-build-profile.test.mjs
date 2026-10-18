import { expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { desktopClientProfile } from "../apps/web/desktop-client-profile.ts";
import { desktopApiProfile, desktopRouteExcluded } from "./desktop-build-profile.mjs";
const root = resolve(import.meta.dirname, "..");
it("[TC-PDDESKTOP-022] builds local auth without administration, organizations or external infrastructure", async () => {
  const api = join(root,"apps/api");
  // Isolate the bundler from API specs that mock source modules in this process.
  const child = Bun.spawn([process.execPath,"--eval", `
    import { desktopApiProfile } from ${JSON.stringify(join(root,"tools/desktop-build-profile.mjs"))};
    const api = ${JSON.stringify(api)};
    const result = await Bun.build({entrypoints:[api+"/src/main.ts",api+"/src/desktop-migrate.ts"],target:"bun",splitting:true,write:false,metafile:true,external:["ioredis","redis","pg","pg-native"],plugins:[desktopApiProfile(api)]});
    if (!result.success) throw new AggregateError(result.logs,"Desktop build failed");
    console.log(JSON.stringify(Object.keys(result.metafile.inputs)));
  `],{cwd:root,stdout:"pipe",stderr:"pipe"});
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(errors).toBe(""); expect(code).toBe(0);
  const inputs = JSON.parse(output);
  for (const pattern of [/src\/admin\.module/,/src\/auth\/auth\.ts$/, /better-auth\/dist\/plugins\/(admin|organization|two-factor)/, /node_modules\/(bullmq|ioredis|pg|nodemailer)\//, /src\/(redis|storage)\/.*module/]) {
    expect(inputs.filter(path => pattern.test(path))).toEqual([]);
  }
  expect(inputs.some(path => path.endsWith("desktop/profile/auth.ts"))).toBe(true);
  expect(inputs.some(path => path.endsWith("desktop/profile/session-guard.ts"))).toBe(true);
});
it("[TC-PDDESKTOP-022] excludes server pages while retaining product screens and the original web routes", async () => {
  for (const path of ["(admin)/admin/users", "(auth)/login", "(auth)/signup", "(app)/dashboard", "oauth2/consent", "setup-2fa", "(shell)/account", "desktop/connect"]) expect(desktopRouteExcluded(path)).toBe(true);
  for (const path of ["(shell)/settings", "(shell)/connection", "(shell)/hosts", "terminal", "install.sh", "agent"]) expect(desktopRouteExcluded(path)).toBe(false);
  const routes = await readdir(join(root,"apps/web/src/routes"));
  expect(routes).toContain("(admin)"); expect(routes).toContain("(auth)");
  const menu = await readFile(join(root,"apps/web/src/lib/dashboard/components/shell-user-menu.svelte"),"utf8");
  expect(menu).toContain('goto("/admin")'); expect(menu).toContain('goto("/account")');
});

it("[TC-PDDESKTOP-022] retains shared HTTP errors and sessions while excluding SDK administration plugins", async () => {
 const original = await readFile(join(root,"node_modules/@podosoft/podokit-api-client/dist/index.js"),"utf8");
 const desktop = desktopClientProfile(original);
 expect(desktop).not.toMatch(/adminClient|organizationClient|twoFactorClient|passkeyClient/);
 expect(desktop).toContain("createAuthClient"); expect(desktop).toContain("export class ApiError"); expect(desktop).toContain("async function request");
 expect(() => desktopClientProfile("incompatible SDK")).toThrow("API client changed");
});
