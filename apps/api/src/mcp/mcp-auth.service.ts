
import { HostMcpKeysService, type McpIdentity } from "./host-mcp-keys.service";
import { looksLikeMcpKey } from "./host-mcp-key.crypto";
import { UserMcpKeysService, type McpUserIdentity } from "./user-mcp-keys.service";
import { looksLikeMcpToken } from "./user-mcp-key.crypto";

/**
 * Which credential was presented, and therefore which surface the caller gets.
 *
 * `host` is a key bound to one machine — the original model, unchanged. `user` is a
 * token that reaches every host in a scope. They are different objects with
 * different blast radii, so they are different tables, different prefixes and
 * different tool surfaces; this file is the one place that decides which is which.
 */
export type McpCaller =
  | { kind: "host"; identity: McpIdentity }
  | { kind: "user"; identity: McpUserIdentity };

export class McpAuthService {
  constructor(
    private readonly hostKeys: HostMcpKeysService,
    private readonly userTokens: UserMcpKeysService,
  ) {}

  /**
   * ⚠ THE PREFIX DECIDES, BEFORE ANY QUERY. Dispatching on shape means a presented
   * credential costs ONE indexed lookup rather than one per kind, and an
   * unrecognised string costs none at all — which is what keeps the 401 path cheap
   * on an endpoint that is reachable without authentication.
   *
   * The two shape checks are mutually exclusive by construction (`pdmux_usr_` is not
   * a prefix of `pdmux_mcp_` in either direction), so the order of these branches
   * carries no meaning and cannot be got wrong.
   */
  async authenticate(plaintext: string): Promise<McpCaller | null> {
    if (looksLikeMcpKey(plaintext)) {
      const identity = await this.hostKeys.authenticate(plaintext);
      return identity ? { kind: "host", identity } : null;
    }
    if (looksLikeMcpToken(plaintext)) {
      const identity = await this.userTokens.authenticate(plaintext);
      return identity ? { kind: "user", identity } : null;
    }
    return null;
  }
}
