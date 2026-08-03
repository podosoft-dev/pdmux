import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Controller, Get, Header, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Public } from "@thallesp/nestjs-better-auth";
import type { Response } from "express";

import { buildZip, type ZipEntry } from "./zip";

/**
 * The skills a coding CLI installs to know how to use pdmux.
 *
 * WHY SHIP THEM RATHER THAN PUT IT ALL IN TOOL DESCRIPTIONS: a description is
 * read one tool at a time, and the things that actually go wrong here are about
 * ORDER and MEANING — check `host_detail` first, `-1` is not an exit code, a
 * read-only key's refusal is a decision rather than a bug. That is a page, not a
 * sentence, and it belongs where the agent reads pages.
 *
 * ⚠ THE ZIP IS BUILT ONCE AND CACHED, INCLUDING ITS DIGEST. The digest is what a
 * person checks before unpacking something into their own `.claude/skills`, so it
 * has to describe the bytes actually served — recomputing it per request would be
 * the same answer at more cost, and building the archive per request would let
 * two downloads disagree.
 *
 * PUBLIC ON PURPOSE: it contains no secret and no host-specific value, and the
 * whole point is that a machine with a key but no session can fetch it.
 */

/** Bumped by hand when a skill changes; a person pins this in their notes. */
const AGENT_KIT_VERSION = "0.2.0";

interface Kit {
  bytes: Buffer;
  sha256: string;
}

let cached: Kit | null = null;

/**
 * Where the skills live, in source and in a built image.
 *
 * The compiled API sits in `dist/`, so the workspace path and the image path are
 * different depths from `__dirname`. Both are tried rather than configured: a
 * missing kit is a 503 with a sentence, and there is nothing here worth an
 * environment variable.
 */
function skillRoots(): string[] {
  return [
    join(__dirname, "..", "..", "..", "..", "packages", "mcp", "skills"),
    join(__dirname, "..", "..", "..", "..", "..", "packages", "mcp", "skills"),
    join(process.cwd(), "packages", "mcp", "skills"),
  ];
}

async function collect(): Promise<ZipEntry[]> {
  for (const root of skillRoots()) {
    try {
      const names = await readdir(root, { withFileTypes: true });
      const entries: ZipEntry[] = [];
      for (const dir of names.filter((entry) => entry.isDirectory())) {
        const files = await readdir(join(root, dir.name));
        for (const file of files) {
          entries.push({
            path: `skills/${dir.name}/${file}`,
            data: await readFile(join(root, dir.name, file)),
          });
        }
      }
      if (entries.length > 0) return entries;
    } catch {
      // Not this root; try the next.
    }
  }
  return [];
}

/**
 * The installer, shipped inside the archive.
 *
 * ⚠ IT NEVER TOUCHES A ROOT `AGENTS.md` OR `CLAUDE.md`. Those are the user's own
 * instructions to their agent; a tool that overwrites them destroys work nobody
 * asked it to touch. It writes only inside the skills directories, and refuses to
 * clobber an existing skill without `--force`.
 */
const INSTALLER = `#!/usr/bin/env node
// Install the pdmux skills into this project.
//   node install.mjs [--claude] [--codex] [--force]
// With no target flag it installs into whichever of .claude/ and .agents/ exists,
// and into .claude/ if neither does.
import { cp, mkdir, access } from "node:fs/promises";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const here = new URL(".", import.meta.url).pathname;

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

const targets = [];
if (args.has("--claude")) targets.push(".claude/skills");
if (args.has("--codex")) targets.push(".agents/skills");
if (targets.length === 0) {
  if (await exists(".claude")) targets.push(".claude/skills");
  if (await exists(".agents")) targets.push(".agents/skills");
  if (targets.length === 0) targets.push(".claude/skills");
}

for (const target of targets) {
  await mkdir(target, { recursive: true });
  // ⚠ THE LIST IS HARDCODED, so a skill added to the package and not to this array
  // ships in nothing and nobody notices — the kit is still a valid zip, it is just
  // missing a third of itself.
  for (const skill of ["pdmux-onboard", "pdmux-operate", "pdmux-fleet"]) {
    const destination = join(target, skill);
    if (!force && (await exists(destination))) {
      console.log(\`skip  \${destination} (already there; pass --force to replace)\`);
      continue;
    }
    await cp(join(here, "skills", skill), destination, { recursive: true });
    console.log(\`write \${destination}\`);
  }
}
console.log("Root AGENTS.md and CLAUDE.md were not touched.");
`;

const README = `# pdmux agent kit

Skills that teach a coding CLI how to use a pdmux host through its hosted MCP.

    node install.mjs            # into .claude/skills and/or .agents/skills
    node install.mjs --force    # replace skills that are already there

It writes only inside those directories. Your root AGENTS.md and CLAUDE.md are
never modified.

Connect the MCP endpoint separately — the host's Agent connection settings show
the exact line for your CLI.
`;

@ApiExcludeController()
@Controller("agent-kit")
@Public()
export class AgentKitController {
  private async kit(): Promise<Kit | null> {
    if (cached) return cached;
    const skills = await collect();
    if (skills.length === 0) return null;
    const bytes = buildZip([
      ...skills,
      { path: "install.mjs", data: Buffer.from(INSTALLER, "utf8") },
      { path: "README.md", data: Buffer.from(README, "utf8") },
    ]);
    cached = { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    return cached;
  }

  @Get("manifest")
  async manifest(@Res() response: Response): Promise<void> {
    const kit = await this.kit();
    if (!kit) {
      response.status(503).json({ error: { code: "AGENT_KIT_UNAVAILABLE", message: "No skills are packaged" } });
      return;
    }
    response.json({ version: AGENT_KIT_VERSION, downloadUrl: "/api/agent-kit", sha256: kit.sha256 });
  }

  @Get()
  @Header("content-type", "application/zip")
  async download(@Res() response: Response): Promise<void> {
    const kit = await this.kit();
    if (!kit) {
      response.status(503).json({ error: { code: "AGENT_KIT_UNAVAILABLE", message: "No skills are packaged" } });
      return;
    }
    // Echoed in a header as well as the manifest, so a `curl -O` can be checked
    // without a second request.
    response.setHeader("x-agent-kit-sha256", kit.sha256);
    response.setHeader("content-disposition", `attachment; filename="pdmux-agent-kit-v${AGENT_KIT_VERSION}.zip"`);
    response.send(kit.bytes);
  }
}
