import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { FullConfig, PlaywrightTestConfig } from "@playwright/test";

type Projects = NonNullable<PlaywrightTestConfig["projects"]>;
type Project = Projects[number];

const requireFromTests = createRequire(__filename);

// A test that changes state the other tests rely on, such as a server-wide
// setting or the profile of a seeded account, takes the `@exclusive` tag:
//
//   test("maintenance mode holds visitors back", { tag: "@exclusive" }, async ({ page }) => { ... });
//
// Playwright matches project grep patterns against the title path followed by
// the test's tags, separated by spaces.
const TAGGED = /(?:^|\s)@exclusive(?=\s|$)/;
const UNTAGGED = /^(?![\s\S]*(?:^|\s)@exclusive(?=\s|$))/;

function projectName(project: unknown): string | null {
  if (typeof project !== "object" || project === null || !("name" in project)) return null;
  return typeof project.name === "string" && project.name.length > 0 ? project.name : null;
}

function patterns(value: Project["grepInvert"]): RegExp[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Merge application-owned Playwright projects into PodoKit's managed config.
 * The optional CommonJS file stays owned so applications can add devices and
 * browsers without creating a 3-way merge hotspot in playwright.config.ts.
 */
export function loadPlaywrightProjects(coreProjects: Projects): Projects {
  const extensionPath = join(__dirname, "playwright.projects.cjs");
  if (!existsSync(extensionPath)) return [];

  const loaded = requireFromTests(extensionPath) as unknown;
  if (!Array.isArray(loaded)) {
    throw new Error("tests/playwright.projects.cjs must export an array of Playwright projects.");
  }

  const names = new Set(
    coreProjects.map((project) => projectName(project)).filter((name): name is string => name !== null),
  );
  for (const project of loaded) {
    const name = projectName(project);
    if (!name) {
      throw new Error("Every project in tests/playwright.projects.cjs must have a non-empty name.");
    }
    if (names.has(name)) {
      throw new Error(`Duplicate Playwright project name: ${name}`);
    }
    names.add(name);
  }

  return loaded as Projects;
}

/** The number of Playwright workers: `E2E_WORKERS`, or 1 when it is unset. */
export function e2eWorkers(value = process.env.E2E_WORKERS): number {
  if (value === undefined || value.trim() === "") return 1;
  const workers = Number(value);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`E2E_WORKERS must be a whole number of at least 1, got "${value}".`);
  }
  return workers;
}

/**
 * Splits each test project into one that skips tests tagged `@exclusive` and an
 * `<name>-exclusive` twin that runs only them on one worker. Projects that
 * another project depends on, or that tear one down, are setup and cleanup
 * projects and stay as they are.
 *
 * With more than one worker the twins depend on every other test project, and
 * each twin on the one before it, so an exclusive test never runs alongside
 * another test. A dependency runs in full, though: a run that selects only
 * exclusive tests, with a file, `--grep`, or `--project`, then also runs every
 * other test first, and a test that fails there skips the exclusive tests. Use
 * more than one worker for the whole suite. With one worker no dependency is
 * needed, so filtered runs stay small.
 */
export function withExclusivePhase(projects: Projects, workers: number): Projects {
  const support = new Set(
    projects.flatMap((project) => [...(project.dependencies ?? []), ...(project.teardown ? [project.teardown] : [])]),
  );
  const tested = projects.filter((project) => !support.has(projectName(project) ?? ""));
  const shared = new Map(
    tested.map((project) => [project, { ...project, grepInvert: [...patterns(project.grepInvert), TAGGED] }]),
  );

  let before = [...shared.values()].map((project) => projectName(project) ?? "");
  const twins = tested.map((project) => {
    const name = `${projectName(project) ?? ""}-exclusive`;
    const twin: Project = {
      ...project,
      name,
      grepInvert: [...patterns(project.grepInvert), UNTAGGED],
      workers: 1,
      dependencies: workers > 1 ? [...(project.dependencies ?? []), ...before] : project.dependencies,
    };
    before = [name];
    return twin;
  });

  const result = [...projects.map((project) => shared.get(project) ?? project), ...twins];
  const names = new Set<string>();
  for (const project of result) {
    const name = projectName(project) ?? "";
    if (names.has(name)) throw new Error(`Duplicate Playwright project name: ${name}`);
    names.add(name);
  }
  return result;
}

/**
 * Global setup: refuses more workers than `E2E_WORKERS` allows for. `--workers`
 * changes the count after the projects were built, so with it the exclusive
 * twins would run alongside the other tests.
 */
export default function checkWorkers(config: FullConfig): void {
  if (config.workers > 1 && e2eWorkers() === 1) {
    throw new Error(
      `Set the worker count with E2E_WORKERS=${config.workers} instead of --workers. ` +
        "Tests tagged @exclusive run after the others only when E2E_WORKERS is above 1.",
    );
  }
}
