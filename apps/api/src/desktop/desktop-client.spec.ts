import { afterEach, expect, it, mock, spyOn } from "bun:test";
import type { Repository } from "typeorm";
import { DesktopClient } from "./desktop-client";
import { WorkspaceMutex, type DesktopService } from "./desktop.service";
import type { DesktopConnection } from "./desktop-connection.entity";
const session = (id: string) => ({ user: { id }, session: {} });
afterEach(() => mock.restore());
function fixture(): { client: DesktopClient; service: DesktopService } {
  const service = { origin: "server", connectionKey: "", mutex: new WorkspaceMutex() } as unknown as DesktopService;
  const store = {
    findOneBy: async ({ userId }: { userId: string }) => userId === "old" ? { userId, state: { deviceId: crypto.randomUUID(), selected: "old-account", accounts: { "old-account": { url: "https://previous.example.test", userId: "remote", scopeId: "personal:remote", bases: {}, hostIds: {}, conflicts: [] } } } } : null,
    save: async (value: unknown) => value,
  } as unknown as Repository<DesktopConnection>;
  return { client: new DesktopClient(service, store), service };
}
it("[TC-PDDESKTOP-012] never copies a previous local profile's cloud cache into a new profile", async () => {
  const { client } = fixture();
  await client.attach(session("old"), "old-local-cookie");
  expect(client.status()).toMatchObject({ serverUrl: "https://previous.example.test" });
  await client.attach(session("new"), "new-local-cookie");
  expect(client.status()).toMatchObject({ serverUrl: null, connected: false });
  expect(() => client.requireProfile(session("old"))).toThrow("Use the active local profile");
  expect(() => client.requireProfile(session("new"))).not.toThrow();
});
it("[TC-PDDESKTOP-012] does not resurrect a pending connection after disconnect", async () => {
  const { client, service } = fixture();
  await client.attach(session("new"), "local-cookie");
  let respond!: (value: Response) => void;
  spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(resolve => { respond = resolve; }));
  const connection = client.connect("https://server.example.test", "cloud-cookie");
  client.disconnect();
  respond(Response.json({ version: 1, userId: "remote", scopeId: "personal:remote", organizations: [] }));
  await expect(connection).rejects.toMatchObject({ code: "DESKTOP_CONNECTION_CANCELLED" });
  expect(client.status()).toMatchObject({ connected: false });
  expect(service.connectionKey).toBe("");
});
