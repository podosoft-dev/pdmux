import { describe, expect, it } from "@jest/globals";

import {
  MCP_TIERS,
  capabilitiesForTier,
  isMcpTier,
  minTier,
  tierAllows,
  tierAtMost,
  tierOfHostScopes,
} from "./mcp-tier";

describe("MCP tiers are a ladder", () => {
  it("orders read below operate below admin", () => {
    expect(tierAtMost("read", "admin")).toBe(true);
    expect(tierAtMost("operate", "admin")).toBe(true);
    expect(tierAtMost("admin", "admin")).toBe(true);
    expect(tierAtMost("operate", "read")).toBe(false);
    expect(tierAtMost("admin", "operate")).toBe(false);
  });

  it("takes the weaker of two tiers, whichever way round they arrive", () => {
    expect(minTier("admin", "read")).toBe("read");
    expect(minTier("read", "admin")).toBe("read");
    expect(minTier("operate", "admin")).toBe("operate");
    expect(minTier("operate", "operate")).toBe("operate");
  });

  it("grows capabilities monotonically", () => {
    // Every tier must contain everything the tier below it has. A capability that
    // appeared at `operate` and vanished at `admin` would be a hole nobody looks for.
    expect(capabilitiesForTier("read")).toEqual(["read"]);
    expect(capabilitiesForTier("operate")).toEqual(expect.arrayContaining([...capabilitiesForTier("read")]));
    expect(capabilitiesForTier("admin")).toEqual(expect.arrayContaining([...capabilitiesForTier("operate")]));
  });

  it("refuses anything that is not one of the three", () => {
    expect(isMcpTier("read")).toBe(true);
    expect(isMcpTier("owner")).toBe(false);
    expect(isMcpTier("")).toBe(false);
    expect(isMcpTier(undefined)).toBe(false);
  });
});

/**
 * ⚠ THE EXECUTABLE FORM OF "A KEY CAN NEVER MINT ANOTHER KEY".
 *
 * `host-mcp-keys.controller.ts` states the rule in prose; this is the assertion that
 * notices when somebody adds a capability that would let a credential grow its own
 * scope. A token that can issue tokens turns one leak into a foothold that revoking
 * the original does not close.
 */
describe("no tier yields a credential-issuing capability", () => {
  it.each([...MCP_TIERS])("%s cannot issue credentials", (tier) => {
    const capabilities = capabilitiesForTier(tier).join(" ");
    expect(capabilities).not.toMatch(/token|key|credential|secret|mint|issue/i);
  });

  it("keeps admin to fleet power, not credential power", () => {
    expect(tierAllows("admin", "admin")).toBe(true);
    expect(tierAllows("operate", "admin")).toBe(false);
    expect(tierAllows("read", "write")).toBe(false);
  });
});

/**
 * The two vocabularies meet only here. Widening `MCP_KEY_SCOPES` to carry `admin`
 * would flow through `CreateMcpKeyDto`'s `@IsIn` and make a fleet-wide power
 * mintable on a credential scoped to one machine.
 */
describe("a host key is read on the same ladder but cannot reach admin", () => {
  it("maps its scopes to read or operate, never higher", () => {
    expect(tierOfHostScopes(["read"])).toBe("read");
    expect(tierOfHostScopes(["read", "write"])).toBe("operate");
    // Even if a row somehow carried the word, the mapping refuses to promote it.
    expect(tierOfHostScopes(["read", "write", "admin"])).toBe("operate");
  });
});
