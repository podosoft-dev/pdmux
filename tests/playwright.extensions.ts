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
const EVERY_FILE = /.*/;

/**
 * One of the two Playwright runs `run-e2e.ts` makes with more than one worker:
 * `shared` runs the tests not tagged `@exclusive`, `exclusive` the tagged ones.
 */
export type E2ePhase = "shared" | "exclusive";

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

/** The run `run-e2e.ts` started, from `E2E_PHASE`, or undefined for a single run. */
export function e2ePhase(value = process.env.E2E_PHASE): E2ePhase | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "shared" || value === "exclusive") return value;
  throw new Error(`E2E_PHASE must be "shared" or "exclusive", got "${value}".`);
}

/**
 * Workers and output folders for this Playwright run. The exclusive phase runs
 * on one worker and keeps its results and HTML report in `exclusive/` folders,
 * because each run empties its own.
 */
export function e2eRunSettings(
  phase = e2ePhase(),
  workers = e2eWorkers(),
): { phase: E2ePhase | undefined; workers: number; outputDir: string; reportFolder: string } {
  return phase === "exclusive"
    ? { phase, workers: 1, outputDir: "test-results/exclusive", reportFolder: "playwright-report/exclusive" }
    : { phase, workers, outputDir: "test-results", reportFolder: "playwright-report" };
}

/**
 * The Playwright runs for `run-e2e.ts` with these command-line arguments. One
 * worker needs a single run. With more workers, the tests not tagged
 * `@exclusive` run first and the tagged ones second, in a run of their own that
 * starts even when the first one failed. Either run may find no tests: a filter
 * can select tests of one kind only, and an app may have no exclusive tests.
 */
export function e2eRuns(args: string[], workers = e2eWorkers()): Array<{ phase?: E2ePhase; args: string[] }> {
  if (workers === 1) return [{ args }];
  return [
    { phase: "shared", args: args.length > 0 ? ["--pass-with-no-tests", ...args] : args },
    { phase: "exclusive", args: ["--pass-with-no-tests", ...args] },
  ];
}

/**
 * Splits each test project into one that skips tests tagged `@exclusive` and an
 * `<name>-exclusive` twin that runs only them on one worker. Projects that
 * another project depends on, or that tear one down, are setup and cleanup
 * projects and stay as they are.
 *
 * With one worker no ordering is needed. With more, `run-e2e.ts` runs
 * Playwright twice: in the `shared` phase the twins find no tests, and in the
 * `exclusive` phase, on one worker, the other test projects find none. A single
 * run with more than one worker (no phase) makes the twins depend on every
 * other test project, and each twin on the one before it, so an exclusive test
 * still never runs alongside another test; but there a failing test skips every
 * twin after it, and a filter that selects exclusive tests runs all other tests
 * first.
 */
export function withExclusivePhase(projects: Projects, workers: number, phase?: E2ePhase): Projects {
  const support = new Set(
    projects.flatMap((project) => [...(project.dependencies ?? []), ...(project.teardown ? [project.teardown] : [])]),
  );
  const tested = projects.filter((project) => !support.has(projectName(project) ?? ""));
  const shared = new Map(
    tested.map((project) => [
      project,
      {
        ...project,
        grepInvert: [...patterns(project.grepInvert), TAGGED],
        ...(phase === "exclusive" ? { testIgnore: EVERY_FILE } : {}),
      },
    ]),
  );

  const chained = workers > 1 && phase === undefined;
  let before = [...shared.values()].map((project) => projectName(project) ?? "");
  const twins = tested.map((project) => {
    const name = `${projectName(project) ?? ""}-exclusive`;
    const twin: Project = {
      ...project,
      name,
      grepInvert: [...patterns(project.grepInvert), UNTAGGED],
      workers: 1,
      dependencies: chained ? [...(project.dependencies ?? []), ...before] : project.dependencies,
      ...(phase === "shared" ? { testIgnore: EVERY_FILE } : {}),
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
 * twins would run alongside the other tests. Warns when more than one worker
 * runs without `run-e2e.ts`, where a failing test skips the exclusive tests.
 */
export default function checkWorkers(config: FullConfig, warn = console.warn): void {
  if (config.workers > 1 && e2eWorkers() === 1) {
    throw new Error(
      `Set the worker count with E2E_WORKERS=${config.workers} instead of --workers. ` +
        "Tests tagged @exclusive run after the others only when E2E_WORKERS is above 1.",
    );
  }
  if (config.workers > 1 && e2ePhase() === undefined) {
    warn(
      "E2E_WORKERS is above 1 in a single Playwright run: a failing test makes Playwright skip " +
        "the tests tagged @exclusive. Run the suite with `bun run test:e2e` (run-e2e.ts), which " +
        "runs them in a second run instead.",
    );
  }
}
