import type { DestroyPlan } from "./gateway";

/**
 * The two answers a tool gives when it is about to change something it cannot undo,
 * and the one it gives when it does not yet know enough to act.
 *
 * ⚠ ONE IMPLEMENTATION, NOT A CONVENTION PER TOOL. A confirmation protocol that each
 * tool spells out for itself is one that drifts: the third tool forgets to say what
 * it would destroy, and a model learns that sometimes the field is missing and stops
 * relying on it.
 */

/** What every tool returns: text content the model reads. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function json(body: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

/**
 * A field the caller has to supply before the tool can act.
 *
 * `why` is not decoration. `address` in particular is a label that pdmux never
 * connects to, and a model that does not know it will happily ssh to it.
 */
export interface NeedsField {
  field: string;
  required: boolean;
  why: string;
  constraint?: string;
  example?: string;
}

/**
 * "I need more from you" — returned, never thrown.
 *
 * ⚠ `isError` IS FALSE, AND THE SCHEMA DECLARES NO REQUIRED PROPERTIES. Both follow
 * from the rule this package already states: "failures are RETURNED, not thrown: a
 * model can read a stable code and correct the call itself, which it cannot do with
 * a transport-level error". A missing zod-required property produces exactly that
 * transport-level error — `InvalidParams` — so declaring the field required would
 * break the rule rather than enforce it.
 *
 * ⚠ AND MCP HAS NO WAY TO ASK. Elicitation is a server→client request; this endpoint
 * is stateless and answers GET with 405, so there is no stream to deliver one on.
 * The asking happens in the CALLER's own conversation, which is why the hint is
 * addressed to the model rather than to the person.
 */
export function needsInput(tool: string, needs: NeedsField[], hint: string): ToolResult {
  return json({ pdmux: "needs-input", tool, needs, hint, next: tool });
}

/**
 * Run a destructive operation, or describe it.
 *
 * `plan()` is a READ-ONLY gateway call and `act()` is the mutator; they are separate
 * methods so a recording fake can prove the mutator was never reached. When `plan()`
 * answers `null` there is nothing to destroy and `act()` runs immediately — that is
 * what keeps minting an enrollment code frictionless on a host that has none.
 */
export async function destructive<T>(
  tool: string,
  input: { confirm?: boolean },
  plan: () => Promise<DestroyPlan | null>,
  act: () => Promise<T>,
): Promise<ToolResult> {
  if (!input.confirm) {
    const preview = await plan();
    if (preview) {
      return json({
        pdmux: "dry-run",
        tool,
        confirmed: false,
        reversible: preview.reversible,
        willDestroy: preview.willDestroy,
        // ⚠ VERBATIM ARGUMENTS. The model does not rebuild the call, so it cannot
        // confirm something other than what it just showed the person.
        retryWith: preview.retryWith,
        hint:
          "Show this list to the user in your own words and call again with retryWith " +
          "ONLY after they agree. Do not assume consent from an earlier instruction — " +
          "'clean up the test hosts' is not agreement to twelve deletions.",
      });
    }
  }
  const result = await act();
  return json({ pdmux: "done", tool, confirmed: input.confirm === true, result });
}
