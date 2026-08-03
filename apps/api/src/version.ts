import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * pdmux's own SemVer — the repo version, NOT the agent's.
 *
 * The two move independently on purpose: the agent has its own version, bumped
 * only when `agent/**` or
 * `packages/protocol/**` changes, because a web-only release must not paint every
 * host amber and then hand it a byte-identical binary. This constant is the other
 * one: what the product as a whole is at, reported in `welcome.serverVersion` and
 * shown in the account menu.
 *
 * WHY IT IS READ, NOT WRITTEN OUT AS A LITERAL: a second copy of the number is a
 * second thing to forget at release time. `package.json` is where npm, the changelog
 * and the release tag already agree, so it is the source. Every workspace carries the
 * same value (`version.spec.ts` fails if one drifts), so reading this app's own
 * manifest reads the repo version.
 *
 * ⚠ `__dirname` resolves to `dist/` in the image and `src/` under ts-jest, and
 * `../package.json` is `apps/api/package.json` from both — the file the runtime stage
 * copies (`COPY --from=deps /app/apps/api ./apps/api`). Do not "simplify" this to a
 * path from `process.cwd()`: the worker entry runs from a different directory.
 */
function readRepoVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return "";
    const version = (parsed as { version?: unknown }).version;
    // The contract caps this field at 32 characters. An over-long value would not be
    // a cosmetic problem: the agent validates every frame against the schema and
    // DISCARDS what fails, so a bad version string here would cost it its `welcome`
    // — config, host id and all. Clipping keeps a silly version merely silly.
    return typeof version === "string" ? version.slice(0, 32) : "";
  } catch {
    // Empty is the schema's own default and reads as "unknown" everywhere. Never
    // throw: the version is advisory, and failing to boot the API over a label
    // nobody gates on would be the worse outcome by far.
    return "";
  }
}

export const SERVER_VERSION: string = readRepoVersion();
