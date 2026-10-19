import { AppException } from "../../common/app-exception";

/** One request's whole budget. Writes answer at once with a task id, so this is generous. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface ProxmoxCredentials {
  baseUrl: string;
  tokenId: string;
  secret: string;
  /** PEM of the CA that signs the node certificate (`/etc/pve/pve-root-ca.pem`). */
  caCertificate: string | null;
}

export type ProxmoxParams = Record<string, string | number | boolean | undefined>;

/**
 * The HTTP half of the Proxmox VE driver: authentication, trust, deadlines and errors.
 *
 * ⚠ TRUST IS THE CLUSTER'S OWN CA, NOT A SKIPPED CHECK. A Proxmox node presents a certificate
 * signed by the cluster's private CA, which no system store knows. The tempting fix — turn
 * verification off and compare a fingerprint — does not exist in Bun: with verification off
 * the identity callback is never called (measured, Bun 1.4, 2026-10-19). Handing the CA to
 * `tls.ca` keeps the full check, hostname included: a wrong CA and a wrong name both fail.
 * A provider with a public certificate leaves `caCertificate` empty and uses the system store.
 *
 * The token secret goes in one header and nowhere else — not in a URL, not in an error.
 */
export class ProxmoxClient {
  private readonly origin: string;

  constructor(
    private readonly credentials: ProxmoxCredentials,
    private readonly requestFetch: typeof fetch = fetch,
  ) {
    this.origin = credentials.baseUrl.replace(/\/+$/, "");
  }

  get<T = unknown>(path: string, params?: ProxmoxParams): Promise<T> {
    return this.request("GET", path, params) as Promise<T>;
  }

  post<T = unknown>(path: string, params?: ProxmoxParams): Promise<T> {
    return this.request("POST", path, params) as Promise<T>;
  }

  put<T = unknown>(path: string, params?: ProxmoxParams): Promise<T> {
    return this.request("PUT", path, params) as Promise<T>;
  }

  /** `null` when the thing to delete is already gone. */
  delete<T = unknown>(path: string, params?: ProxmoxParams): Promise<T | null> {
    return this.request("DELETE", path, params) as Promise<T | null>;
  }

  private async request(method: string, path: string, params: ProxmoxParams = {}): Promise<unknown> {
    const encoded = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      encoded.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    }
    const query = method === "GET" || method === "DELETE";
    const url = `${this.origin}/api2/json${path}${query && encoded.size > 0 ? `?${encoded}` : ""}`;
    const init: RequestInit & { tls?: { ca: string } } = {
      method,
      headers: {
        authorization: `PVEAPIToken=${this.credentials.tokenId}=${this.credentials.secret}`,
        ...(query ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(query ? {} : { body: encoded.toString() }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(this.credentials.caCertificate ? { tls: { ca: this.credentials.caCertificate } } : {}),
    };

    let response: Response;
    try {
      response = await this.requestFetch(url, init);
    } catch (error) {
      throw transportFailure(error);
    }
    const payload = await response.json().catch(() => null) as { data?: unknown; message?: unknown; errors?: unknown } | null;
    if (response.ok) return payload?.data ?? null;
    const text = describe(payload);
    // Deleting what is already gone is the outcome the caller wanted.
    if (method === "DELETE" && (response.status === 404 || /does not exist/i.test(text))) return null;
    throw requestFailure(response.status, text);
  }
}

function describe(payload: { message?: unknown; errors?: unknown } | null): string {
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  const errors = payload?.errors && typeof payload.errors === "object"
    ? Object.values(payload.errors as Record<string, unknown>).filter((value) => typeof value === "string").join("; ")
    : "";
  return [message, errors].filter(Boolean).join(" — ");
}

function transportFailure(error: unknown): AppException {
  const text = error instanceof Error ? `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? "")}` : String(error);
  if (/certificate|CERT_|TLS|SSL|self[- ]signed|verify/i.test(text)) {
    return new AppException("VM_PROVIDER_TLS_FAILED", "The provider's certificate could not be verified", 502);
  }
  if (/timeout|abort/i.test(text)) {
    return new AppException("VM_PROVIDER_TIMEOUT", "The provider did not answer in time", 502);
  }
  return new AppException("VM_PROVIDER_UNAVAILABLE", "The provider could not be reached", 502);
}

/**
 * A refusal, by kind. The provider's own text is NOT passed on: it names nodes, storage and
 * paths, and an error envelope reaches the browser. The kinds are what a screen can act on.
 */
function requestFailure(status: number, text: string): AppException {
  if (status === 401) return new AppException("VM_PROVIDER_AUTH_FAILED", "The provider rejected the credentials", 502);
  if (status === 403) return new AppException("VM_PROVIDER_FORBIDDEN", "The provider credentials may not do this", 502);
  if (/already exists/i.test(text)) return new AppException("VM_ID_TAKEN", "The provider already has a machine with this id", 409);
  if (/already running/i.test(text)) return new AppException("VM_ALREADY_RUNNING", "The machine is already running", 409);
  if (/not running/i.test(text)) return new AppException("VM_NOT_RUNNING", "The machine is not running", 409);
  if (/does not exist|no such/i.test(text)) return new AppException("VM_NOT_FOUND", "The provider has no such machine", 404);
  if (/lock|locked/i.test(text)) return new AppException("VM_LOCKED", "The machine is busy with another task", 409);
  return new AppException("VM_PROVIDER_REQUEST_FAILED", "The provider rejected the request", 502);
}
