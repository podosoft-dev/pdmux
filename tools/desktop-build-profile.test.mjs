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
    import { mkdtemp, mkdir, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { Database } from "bun:sqlite";
    const api = ${JSON.stringify(api)};
    const fixture = await mkdtemp(join(tmpdir(),"pdmux-offline-services-"));
    try {
    // An installed bundle must not resolve repository dependencies or download them.
    await mkdir(join(fixture,"node_modules"));
    const outdir = join(fixture,"api");
    const result = await Bun.build({entrypoints:[api+"/src/main.ts",api+"/src/desktop-migrate.ts"],root:api+"/src",outdir,target:"bun",splitting:true,metafile:true,define:{"process.env.NODE_ENV":JSON.stringify("production")},external:["ioredis","redis","pg","pg-native"],plugins:[desktopApiProfile(api)]});
    if (!result.success) throw new AggregateError(result.logs,"Desktop build failed");
    const env = {...process.env,NODE_ENV:"production",DATABASE_PROVIDER:"sqlite",DATABASE_URL:"sqlite://"+join(fixture,"pdmux.sqlite"),CACHE_PROVIDER:"memory",OBJECT_STORAGE_PROVIDER:"local",LOCAL_STORAGE_PATH:join(fixture,"files"),EVENTS_PROVIDER:"memory",JOBS_PROVIDER:"local",BETTER_AUTH_SECRET:"offline-regression-secret-with-at-least-32-characters",BETTER_AUTH_URL:"http://127.0.0.1:5002",CORS_ORIGIN:"http://127.0.0.1:5001",BUN_INSTALL_CACHE_DIR:join(fixture,"empty-cache"),npm_config_registry:"http://127.0.0.1:1"};
    for (let run=0;run<2;run++) {
      const migrate=Bun.spawn([process.execPath,"--no-install",join(outdir,"desktop-migrate.js")],{cwd:outdir,env,stdout:"pipe",stderr:"pipe"});
      const [code,stdout,stderr]=await Promise.all([migrate.exited,new Response(migrate.stdout).text(),new Response(migrate.stderr).text()]);
      if(code!==0) throw new Error("Isolated offline migration failed: "+stdout+stderr);
    }
    const db=new Database(join(fixture,"pdmux.sqlite"),{readonly:true});
    const tables=db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name);
    db.close();
    console.log(JSON.stringify({inputs:Object.keys(result.metafile.inputs),tables,postgresImports:(await Promise.all(result.outputs.map(output=>output.text()))).filter(source=>/from ["']pg["']/.test(source)).length}));
    } finally { await rm(fixture,{recursive:true,force:true}); }
  `],{cwd:root,stdout:"pipe",stderr:"pipe"});
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(errors).toBe(""); expect(code).toBe(0);
  const {inputs,tables,postgresImports} = JSON.parse(output);
  expect(postgresImports).toBe(0);
  expect(tables).toContain("user");
  expect(tables).toContain("hosts");
  for (const pattern of [/src\/admin\.module/,/src\/auth\/auth\.ts$/, /better-auth\/dist\/plugins\/(admin|organization|two-factor)/, /node_modules\/(bullmq|ioredis|pg|nodemailer)\//, /src\/(redis|storage)\/.*module/]) {
    expect(inputs.filter(path => pattern.test(path))).toEqual([]);
  }
  expect(inputs.some(path => path.endsWith("desktop/profile/auth.ts"))).toBe(true);
  expect(inputs.some(path => path.endsWith("desktop/profile/session-guard.ts"))).toBe(true);
}, 30_000);
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
