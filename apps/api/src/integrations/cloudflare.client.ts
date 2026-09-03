import { AppException } from "../common/app-exception";

const API_ORIGIN = "https://api.cloudflare.com/client/v4";

interface Envelope {
  success?: boolean;
  result?: unknown;
  result_info?: unknown;
}

interface IdentifierName {
  id: string;
  name: string;
}

export interface CloudflareZone extends IdentifierName {
  accountId: string;
  accountName: string;
}

export interface CloudflarePolicy extends IdentifierName {
  accountId: string;
}

export interface CloudflareIngress {
  hostname: string;
  service: string;
  originRequest?: { noTLSVerify: boolean };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function identifierName(value: unknown): IdentifierName | null {
  const row = object(value);
  return typeof row.id === "string" && typeof row.name === "string"
    ? { id: row.id, name: row.name }
    : null;
}

/** Minimal Cloudflare API adapter. It owns every provider-specific path and shape. */
export class CloudflareClient {
  constructor(
    private readonly token: string,
    private readonly requestFetch: typeof fetch = fetch,
  ) {}

  async zones(): Promise<CloudflareZone[]> {
    const result = await this.list("/zones?status=active&per_page=50");
    return result.flatMap((value) => {
      const zone = identifierName(value);
      const account = identifierName(object(value).account);
      return zone && account
        ? [{ ...zone, accountId: account.id, accountName: account.name }]
        : [];
    });
  }

  async policies(accountId: string): Promise<CloudflarePolicy[]> {
    const result = await this.list(`/accounts/${encodeURIComponent(accountId)}/access/policies?per_page=50`);
    return result.flatMap((value) => {
      const policy = identifierName(value);
      return policy ? [{ ...policy, accountId }] : [];
    });
  }

  async createTunnel(accountId: string, name: string): Promise<{ id: string; token: string }> {
    const result = object(await this.request(`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name, config_src: "cloudflare" }),
    }));
    if (typeof result.id !== "string") throw this.invalidResponse();
    const token = typeof result.token === "string"
      ? result.token
      : await this.tunnelToken(accountId, result.id);
    return { id: result.id, token };
  }

  async tunnelToken(accountId: string, tunnelId: string): Promise<string> {
    const result = await this.request(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
      { method: "GET" },
    );
    if (typeof result !== "string") throw this.invalidResponse();
    return result;
  }

  async putIngress(accountId: string, tunnelId: string, routes: CloudflareIngress[]): Promise<void> {
    await this.request(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      {
        method: "PUT",
        body: JSON.stringify({ config: { ingress: [...routes, { service: "http_status:404" }] } }),
      },
    );
  }

  async createDns(zoneId: string, hostname: string, tunnelId: string): Promise<string> {
    const result = object(await this.request(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      }),
    }));
    if (typeof result.id !== "string") throw this.invalidResponse();
    return result.id;
  }

  async createAccessApp(
    accountId: string,
    hostname: string,
    policyId: string,
  ): Promise<string> {
    const result = object(await this.request(
      `/accounts/${encodeURIComponent(accountId)}/access/apps`,
      {
        method: "POST",
        body: JSON.stringify({
          name: `pdmux ${hostname}`,
          domain: hostname,
          type: "self_hosted",
          session_duration: "24h",
          policies: [{ id: policyId }],
        }),
      },
    ));
    if (typeof result.id !== "string") throw this.invalidResponse();
    return result.id;
  }

  deleteDns(zoneId: string, recordId: string): Promise<void> {
    return this.remove(`/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`);
  }

  deleteAccessApp(accountId: string, appId: string): Promise<void> {
    return this.remove(`/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}`);
  }

  deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    return this.remove(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}?cleanup_connections=true`,
    );
  }

  private async remove(path: string): Promise<void> {
    await this.request(path, { method: "DELETE" });
  }

  private async list(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const envelope = await this.requestEnvelope(`${path}&page=${page}`, { method: "GET" });
      if (!Array.isArray(envelope.result)) throw this.invalidResponse();
      rows.push(...envelope.result);
      const info = object(envelope.result_info);
      const totalPages = typeof info.total_pages === "number" ? info.total_pages : null;
      if ((totalPages !== null && page >= totalPages) || envelope.result.length < 50) return rows;
    }
    throw this.invalidResponse();
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    return (await this.requestEnvelope(path, init)).result;
  }

  private async requestEnvelope(path: string, init: RequestInit): Promise<Envelope> {
    let response: Response;
    try {
      response = await this.requestFetch(`${API_ORIGIN}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
      });
    } catch {
      throw new AppException("CLOUDFLARE_UNAVAILABLE", "Cloudflare could not be reached", 502);
    }
    const payload = object(await response.json().catch(() => ({}))) as Envelope;
    if (init.method === "DELETE" && response.status === 404) return { success: true, result: null };
    if (!response.ok || payload.success !== true) {
      throw new AppException("CLOUDFLARE_REQUEST_FAILED", "Cloudflare rejected the request", 502);
    }
    return payload;
  }

  private invalidResponse(): AppException {
    return new AppException("CLOUDFLARE_INVALID_RESPONSE", "Cloudflare returned an invalid response", 502);
  }
}
