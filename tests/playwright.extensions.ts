import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { TestConfig } from "@playwright/test";

type Projects = NonNullable<TestConfig["projects"]>;

const requireFromTests = createRequire(__filename);

function projectName(project: unknown): string | null {
  if (typeof project !== "object" || project === null || !("name" in project)) return null;
  return typeof project.name === "string" && project.name.length > 0 ? project.name : null;
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
