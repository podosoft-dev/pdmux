/**
 * Runtime stub for `@pdmux/mcp` used by jest only (wired through `moduleNameMapper`
 * in the api package.json), for the same reason as `nestjs-better-auth.stub.ts`:
 * that package is ESM and these unit tests run in jest's CommonJS runtime, so
 * importing `mcp.controller.ts` explodes on its `export` syntax before a single
 * assertion runs.
 *
 * ⚠ THIS IS WHY `/mcp` HAD NO CONTROLLER SPEC. The comment in `mcp.controller.ts`
 * claimed one existed for the check order; what actually stopped it being written
 * was this import, not a lapse. Mapping the module here is the whole fix.
 *
 * ⚠ AND IT IS WHY THIS STUB MUST STAY EMPTY OF BEHAVIOUR. What the tool surface
 * does is asserted in `packages/mcp/test/server-contract.test.ts`, which runs under
 * vitest and imports the real thing. A stub that grew opinions would let a spec in
 * this package appear to cover the surface while measuring nothing. Everything the
 * controller spec asserts happens *before* the server is built.
 */

/** Enough of an `McpServer` for the controller to connect and close one. */
export function createPdmuxMcpServer(): {
  connect: () => Promise<void>;
  close: () => Promise<void>;
} {
  return {
    connect: async () => undefined,
    close: async () => undefined,
  };
}

export const PDMUX_TOOL_NAMES: readonly string[] = [];
