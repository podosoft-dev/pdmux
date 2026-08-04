/**
 * Every dashboard call the browser makes, in one module.
 *
 * The browser never dials the API directly: `$lib/api` points at this app's own
 * origin and the SvelteKit server proxies `/api/*` onwards with the session cookie.
 * Keeping the paths here (rather than inline in components) means a route rename is
 * one edit, and every caller gets the same typed answer.
 */
import { ApiError } from "@podosoft/podokit-api-client";
import type { CommitDetail, GitBlob, GitTree, WorkingDiff } from "@pdmux/protocol";
import { api } from "$lib/api";
import type {
  AgentEnrollmentView,
  AgentTokenView,
  McpKeyView,
  McpTokenPolicy,
  McpTokenView,
  MintedMcpToken,
  MintedMcpKey,
  AgentUpdateCommand,
  CreatedHost,
  DetailResponse,
  FleetSettingsView,
  FleetUpdateResult,
  HostGitRootView,
  HostServiceView,
  HostView,
  MetricsResponse,
  MintedAgentEnrollment,
  MintedAgentToken,
  PrefsView,
  RepoGraphResponse,
  RepoRow,
} from "./types";

export interface HostInput {
  label: string;
  address?: string | null;
  description?: string | null;
  tags?: string[];
}

export interface ServiceInputDto {
  label: string;
  port: number;
  probe?: "tcp" | "http" | "none";
  path?: string;
  urlTemplate?: string | null;
  enabled?: boolean;
}

/**
 * The error code a failure carries, or a transport marker.
 *
 * Callers branch on this, never on the message: the message is localised prose from
 * the server and changing it must not change behaviour (AGENTS.md).
 */
export function errorCode(cause: unknown): string {
  if (cause instanceof ApiError) return cause.code;
  return "NETWORK_ERROR";
}

export const hostsApi = {
  list: (): Promise<HostView[]> => api.get<HostView[]>("/hosts"),
  get: (id: string): Promise<HostView> => api.get<HostView>(`/hosts/${id}`),
  /**
   * Registers the host AND returns its first enrollment code, in one request.
   *
   * A row in a table is not a machine — the step that makes it one needs a code, so
   * handing it back here is what turns "register a host" into a single operator
   * action. `enrollment` may be `null` (the mint failed, the host did not): the
   * install dialog falls back to minting one itself.
   */
  create: (input: HostInput): Promise<CreatedHost> => api.post<CreatedHost>("/hosts", input),
  update: (id: string, input: Partial<HostInput>): Promise<HostView> =>
    api.patch<HostView>(`/hosts/${id}`, input),
  /**
   * Hand this host to another account.
   *
   * The row moves whole — tokens, services and history hang off its id, so the
   * agent keeps running and is never reinstalled. It simply stops being ours.
   */
  move: (id: string, targetEmail: string): Promise<HostView> =>
    api.post<HostView>(`/hosts/${id}/move`, { targetEmail }),
  remove: (id: string): Promise<{ id: string; label: string }> =>
    api.del<{ id: string; label: string }>(`/hosts/${id}`),
  setEnabled: (id: string, enabled: boolean): Promise<HostView> =>
    api.put<HostView>(`/hosts/${id}/enabled`, { enabled }),
  // The whole order travels, not the moved pair: that makes a reorder idempotent
  // and immune to a dropped click.
  reorder: (ids: string[]): Promise<HostView[]> => api.put<HostView[]>("/hosts/reorder", { ids }),
};

export const servicesApi = {
  list: (hostId: string): Promise<HostServiceView[]> =>
    api.get<HostServiceView[]>(`/hosts/${hostId}/services`),
  create: (hostId: string, input: ServiceInputDto): Promise<HostServiceView> =>
    api.post<HostServiceView>(`/hosts/${hostId}/services`, input),
  update: (hostId: string, id: string, input: Partial<ServiceInputDto>): Promise<HostServiceView> =>
    api.patch<HostServiceView>(`/hosts/${hostId}/services/${id}`, input),
  remove: (hostId: string, id: string): Promise<{ id: string; label: string }> =>
    api.del<{ id: string; label: string }>(`/hosts/${hostId}/services/${id}`),
  reorder: (hostId: string, ids: string[]): Promise<HostServiceView[]> =>
    api.put<HostServiceView[]>(`/hosts/${hostId}/services/reorder`, { ids }),
};

/**
 * ⚠ A CHANGE HERE PUSHES A NEW CONFIG TO THE AGENT, so the git graph fills in
 * seconds rather than at the next reconnect. That is the server's doing
 * (`notifyChanged`), but it is why the card can refresh the repo list right
 * after a write instead of telling somebody to come back later.
 */
export const gitRootsApi = {
  list: (hostId: string): Promise<HostGitRootView[]> =>
    api.get<HostGitRootView[]>(`/hosts/${hostId}/git-roots`),
  create: (hostId: string, path: string): Promise<HostGitRootView> =>
    api.post<HostGitRootView>(`/hosts/${hostId}/git-roots`, { path }),
  update: (
    hostId: string,
    id: string,
    input: { path?: string; enabled?: boolean },
  ): Promise<HostGitRootView> =>
    api.patch<HostGitRootView>(`/hosts/${hostId}/git-roots/${id}`, input),
  remove: (hostId: string, id: string): Promise<{ id: string; path: string }> =>
    api.del<{ id: string; path: string }>(`/hosts/${hostId}/git-roots/${id}`),
};

export const tokensApi = {
  list: (hostId: string): Promise<AgentTokenView[]> => api.get<AgentTokenView[]>(`/hosts/${hostId}/tokens`),
  /**
   * `expiresInDays` is omitted rather than sent as null when the token should
   * never expire: the API declares it optional, and `forbidNonWhitelisted` means
   * a field is either one it accepts or a 400 — "absent" is the only way to say
   * never.
   */
  mint: (hostId: string, name: string, expiresInDays?: number): Promise<MintedAgentToken> =>
    api.post<MintedAgentToken>(`/hosts/${hostId}/tokens`, {
      name,
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
    }),
  rotate: (hostId: string, id: string): Promise<MintedAgentToken> =>
    api.post<MintedAgentToken>(`/hosts/${hostId}/tokens/${id}/rotate`),
  revoke: (hostId: string, id: string): Promise<AgentTokenView> =>
    api.del<AgentTokenView>(`/hosts/${hostId}/tokens/${id}`),
};

/**
 * Enrollment codes — the short-lived secret the one-line installer redeems.
 *
 * `create` is the only call that ever returns the plaintext, and minting again
 * REPLACES whatever code the host had. That is why "regenerate" is one button and
 * not a revoke-then-mint pair: two live codes for one host would mean a mistyped
 * one still works.
 */
export const enrollmentsApi = {
  /**
   * `tokenExpiresInDays` is the operator's choice of how long the token this code
   * buys should live; omitted means never, which is what a real host wants.
   *
   * ⚠ A BODY IS SENT EVEN WHEN THERE IS NOTHING TO SAY. Without one the client
   * sends no `content-type`, and Express 5's json parser then leaves `req.body`
   * UNDEFINED rather than `{}` — so the route would be reading a property off
   * nothing. The API tolerates the absence too; this is the half that stops it
   * from ever happening.
   */
  create: (hostId: string, tokenExpiresInDays?: number): Promise<MintedAgentEnrollment> =>
    api.post<MintedAgentEnrollment>(
      `/hosts/${hostId}/enrollments`,
      tokenExpiresInDays === undefined ? {} : { tokenExpiresInDays },
    ),
  /** State only — the code is never in this answer, by design. */
  current: (hostId: string): Promise<AgentEnrollmentView | null> =>
    api.get<AgentEnrollmentView | null>(`/hosts/${hostId}/enrollments/current`),
  revoke: (hostId: string, id: string): Promise<AgentEnrollmentView> =>
    api.del<AgentEnrollmentView>(`/hosts/${hostId}/enrollments/${id}`),
};

/**
 * "Replace yourself with this build" — one host, or a batch.
 *
 * The fleet call answers with an OUTCOME rather than throwing on partial failure:
 * some hosts started, some refused, some were never reached. A caller that only
 * looked at "did it throw" would report a stopped rollout as a success.
 */
export const agentUpdateApi = {
  host: (hostId: string, input: { version?: string | null; force?: boolean } = {}): Promise<AgentUpdateCommand> =>
    api.post<AgentUpdateCommand>(`/hosts/${hostId}/agent/update`, input),
  fleet: (hostIds: string[], version: string): Promise<FleetUpdateResult> =>
    api.post<FleetUpdateResult>("/fleet/agent/update", { hostIds, version }),
};

export const metricsApi = {
  series: (hostId: string, windowSec: number): Promise<MetricsResponse> =>
    api.get<MetricsResponse>(`/hosts/${hostId}/metrics?window=${windowSec}`),
};

export const gitApi = {
  repos: (hostId: string): Promise<RepoRow[]> => api.get<RepoRow[]>(`/hosts/${hostId}/repos`),
  /**
   * "Do a pass now" — the endpoint that already existed for the host card's refresh.
   *
   * `remote` is the one that leaves the machine: it runs `ls-remote`, which reads the
   * remote's refs and writes nothing to the checkout. It is never on the agent's own
   * timer, so this call is the only way it ever happens.
   */
  collect: (hostId: string, what: "repos" | "remote"): Promise<{ hostId: string; what: string }> =>
    api.post<{ hostId: string; what: string }>(`/hosts/${hostId}/collect`, { what }),
  graph: (hostId: string, repoId: string): Promise<RepoGraphResponse> =>
    api.get<RepoGraphResponse>(`/hosts/${hostId}/repos/${repoId}`),
  // Fetched on a click and never with the graph: bodies and patches were 58% of a
  // feed nobody had asked to see (ARCHITECTURE §4).
  commitDetail: (hostId: string, repoId: string, sha: string): Promise<DetailResponse<CommitDetail>> =>
    api.get<DetailResponse<CommitDetail>>(`/hosts/${hostId}/repos/${repoId}/commits/${sha}/detail`),
  workingDiff: (hostId: string, repoId: string): Promise<DetailResponse<WorkingDiff>> =>
    api.get<DetailResponse<WorkingDiff>>(`/hosts/${hostId}/repos/${repoId}/working-diff`),
  /**
   * The paths that existed at a commit — metadata only.
   *
   * ⚠ TWO CALLS, NOT ONE. This is a few thousand names and sizes; the files under
   * them are the whole repository. Fetching contents with the listing would send
   * megabytes to draw a list nobody has clicked into.
   */
  commitTree: (hostId: string, repoId: string, sha: string): Promise<DetailResponse<GitTree>> =>
    api.get<DetailResponse<GitTree>>(`/hosts/${hostId}/repos/${repoId}/commits/${sha}/tree`),
  commitBlob: (hostId: string, repoId: string, sha: string, path: string): Promise<DetailResponse<GitBlob>> =>
    api.get<DetailResponse<GitBlob>>(
      `/hosts/${hostId}/repos/${repoId}/commits/${sha}/blob?path=${encodeURIComponent(path)}`,
    ),
};

export const prefsApi = {
  read: (): Promise<PrefsView> => api.get<PrefsView>("/prefs"),
  putLayout: (name: string, payload: Record<string, unknown>, isDefault = true): Promise<unknown> =>
    api.put<unknown>(`/prefs/layouts/${name}`, { payload, isDefault }),
  putHostPref: (hostId: string, widgets: Record<string, unknown>): Promise<unknown> =>
    api.put<unknown>(`/prefs/hosts/${hostId}`, { widgets }),
};

export const fleetApi = {
  settings: (): Promise<FleetSettingsView> => api.get<FleetSettingsView>("/fleet/settings"),
  /**
   * Writes the settings that CHANGED and answers with the whole document.
   *
   * A partial body is the point, not an optimisation: the endpoint upserts only the
   * keys it is given, so sending the untouched ones would stamp this browser's view
   * over an edit a colleague made in between. `Partial` is also exactly what the DTO
   * declares — and `forbidNonWhitelisted` means anything it does not declare is a 400,
   * so the patch is built from the settings keys and nothing else.
   */
  updateSettings: (input: Partial<FleetSettingsView>): Promise<FleetSettingsView> =>
    api.put<FleetSettingsView>("/fleet/settings", input),
};

/**
 * The credential a coding CLI presents to `<origin>/mcp`.
 *
 * `create` is the only call that ever returns the plaintext — the server stores a
 * hash, so there is no "show it again". Revocation is immediate and permanent;
 * there is no rotate, because minting a second key is the same two clicks and
 * leaves the first one's `lastUsedAt` intact as evidence.
 */
export const mcpKeysApi = {
  list: (hostId: string): Promise<McpKeyView[]> => api.get<McpKeyView[]>(`/hosts/${hostId}/mcp-keys`),
  mint: (hostId: string, input: { label: string; expiresInDays: number; scopes: string[] }): Promise<MintedMcpKey> =>
    api.post<MintedMcpKey>(`/hosts/${hostId}/mcp-keys`, input),
  revoke: (hostId: string, id: string): Promise<McpKeyView> =>
    api.del<McpKeyView>(`/hosts/${hostId}/mcp-keys/${id}`),
};

/**
 * The credential that reaches a whole fleet.
 *
 * ⚠ NO HOST ID ANYWHERE. The scope comes from the session, and a person sees and
 * revokes their own tokens in the scope they are currently in — there is no path
 * that lists somebody else's, and no parameter that could ask for one.
 */
export const mcpTokensApi = {
  policy: (): Promise<McpTokenPolicy> => api.get<McpTokenPolicy>("/account/mcp-tokens/policy"),
  list: (): Promise<McpTokenView[]> => api.get<McpTokenView[]>("/account/mcp-tokens"),
  mint: (input: { label: string; expiresInDays: number; tier: string }): Promise<MintedMcpToken> =>
    api.post<MintedMcpToken>("/account/mcp-tokens", input),
  revoke: (id: string): Promise<McpTokenView> => api.del<McpTokenView>(`/account/mcp-tokens/${id}`),
};
