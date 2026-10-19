import { describe, expect, it } from "bun:test";
import { AppException } from "../../common/app-exception";
import { ProxmoxClient } from "./proxmox.client";

type Recorded = { method: string; url: URL; headers: Headers; body: string; tls: unknown };

function fake(respond: (request: Recorded) => Response | Promise<Response>): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const requestFetch = async (input: string | URL | Request, init?: RequestInit & { tls?: unknown }): Promise<Response> => {
    const request: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(typeof input === "string" || input instanceof URL ? input : input.url),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
      tls: init?.tls,
    };
    requests.push(request);
    return respond(request);
  };
  return { fetch: requestFetch as typeof fetch, requests };
}

const credentials = {
  baseUrl: "https://pve.example.test:8006/",
  tokenId: "pdmux@pve!vm-provider",
  secret: "11111111-2222-3333-4444-555555555555",
  caCertificate: "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n",
};

async function failure(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("ProxmoxClient", () => {
  it("[TC-PDVM-001] sends one token header on every request and keeps the secret out of URLs and errors", async () => {
    const { fetch, requests } = fake((request) =>
      request.method === "GET" ? Response.json({ data: { version: "9.2.21" } }) : Response.json({ message: "rejected" }, { status: 500 }),
    );
    const client = new ProxmoxClient(credentials, fetch);

    expect(await client.get<{ version: string }>("/version")).toEqual({ version: "9.2.21" });
    const error = await failure(client.post("/nodes/n1/qemu/500/status/start", { skiplock: false }));

    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe(`PVEAPIToken=${credentials.tokenId}=${credentials.secret}`);
      expect(request.url.toString()).not.toContain(credentials.secret);
    }
    expect(requests[0]?.url.toString()).toBe("https://pve.example.test:8006/api2/json/version");
    // Writes are form-encoded, the way the Proxmox API reads them.
    expect(requests[1]?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(requests[1]?.body).toBe("skiplock=0");
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(credentials.secret);
  });

  it("[TC-PDVM-002] trusts the stored CA for the provider's certificate and reports a failed verification as such", async () => {
    const { fetch, requests } = fake(() => Response.json({ data: null }));
    await new ProxmoxClient(credentials, fetch).get("/version");
    expect(requests[0]?.tls).toEqual({ ca: credentials.caCertificate });

    // Without a CA the system store decides — nothing is switched off.
    const system = fake(() => Response.json({ data: null }));
    await new ProxmoxClient({ ...credentials, caCertificate: null }, system.fetch).get("/version");
    expect(system.requests[0]?.tls).toBeUndefined();

    // Bun's wording for a chain it cannot verify (measured against a node certificate).
    const rejecting = fake(() => {
      throw new Error("unable to verify the first certificate");
    });
    const tls = await failure(new ProxmoxClient(credentials, rejecting.fetch).get("/version"));
    expect(tls.code).toBe("VM_PROVIDER_TLS_FAILED");
    const altname = fake(() => {
      throw Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    });
    expect((await failure(new ProxmoxClient(credentials, altname.fetch).get("/version"))).code).toBe("VM_PROVIDER_TLS_FAILED");
  });

  it("[TC-PDVM-004] turns refusals into codes a screen can act on, without the provider's own text", async () => {
    const answer = (status: number, message: string) => fake(() => Response.json({ data: null, message }, { status }));
    const cases: [number, string, string][] = [
      [401, "authentication failure", "VM_PROVIDER_AUTH_FAILED"],
      [403, "Permission check failed (/vms/999, VM.Audit)", "VM_PROVIDER_FORBIDDEN"],
      [500, "VM 500 already running", "VM_ALREADY_RUNNING"],
      [500, "VM 500 not running", "VM_NOT_RUNNING"],
      [500, "Configuration file 'nodes/n1/qemu-server/999.conf' does not exist", "VM_NOT_FOUND"],
      [500, "can't lock file '/var/lock/qemu-server/lock-500.conf' - got timeout", "VM_LOCKED"],
      [500, "something else on node n1 storage local-lvm", "VM_PROVIDER_REQUEST_FAILED"],
    ];
    for (const [status, message, code] of cases) {
      const error = await failure(new ProxmoxClient(credentials, answer(status, message).fetch).get("/x"));
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("local-lvm");
      expect(error.message).not.toContain("/vms/999");
    }
    // A parameter error names the field in `errors` rather than in `message`.
    const taken = fake(() => Response.json({ data: null, message: "Parameter verification failed.", errors: { vmid: "VM 161 already exists" } }, { status: 400 }));
    expect((await failure(new ProxmoxClient(credentials, taken.fetch).get("/cluster/nextid", { vmid: 161 }))).code).toBe("VM_ID_TAKEN");

    const unreachable = fake(() => {
      throw new TypeError("fetch failed");
    });
    expect((await failure(new ProxmoxClient(credentials, unreachable.fetch).get("/x"))).code).toBe("VM_PROVIDER_UNAVAILABLE");
    const slow = fake(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect((await failure(new ProxmoxClient(credentials, slow.fetch).get("/x"))).code).toBe("VM_PROVIDER_TIMEOUT");
  });

  it("[TC-PDVM-004] treats deleting a machine that is already gone as done", async () => {
    const gone = fake(() => Response.json({ data: null, message: "Configuration file 'nodes/n1/qemu-server/500.conf' does not exist" }, { status: 500 }));
    expect(await new ProxmoxClient(credentials, gone.fetch).delete("/nodes/n1/qemu/500", { "destroy-unreferenced-disks": 1 })).toBeNull();
    expect(gone.requests[0]?.url.search).toBe("?destroy-unreferenced-disks=1");
    const notFound = fake(() => new Response("", { status: 404 }));
    expect(await new ProxmoxClient(credentials, notFound.fetch).delete("/nodes/n1/qemu/500")).toBeNull();
  });
});
