/**
 * A fleet row as `GET /hosts` returns it, fabricated.
 *
 * WHY A MOCK AND NOT A REAL HOST: the five version states cannot all be produced by
 * real agents on one machine — `ahead` needs a build newer than anything published
 * and `incompatible` needs a different wire contract. The BEHAVIOUR under test is
 * what a screen does with each one, which is exactly what a fabricated row drives.
 *
 * ⚠ SHARED BECAUSE TWO SCREENS READ THE SAME ENDPOINT. The sidebar and the host
 * table are both fed by `GET /hosts`, so a mock written for one drives the other for
 * free — and two copies would drift into disagreeing about what a `HostView` looks
 * like, which is the failure this file prevents rather than the duplication.
 */

export type MockHost = Record<string, unknown>;

export function mockHost(label: string, overrides: MockHost = {}): MockHost {
  return {
    id: `00000000-0000-4000-8000-${label.replace(/\W/g, "").slice(-12).padStart(12, "0")}`,
    label,
    address: "10.9.9.9",
    agentAddress: null,
    description: null,
    tags: [],
    sortOrder: 0,
    enabled: true,
    agentVersion: "1.4.0",
    latestAgentVersion: "1.5.0",
    agentVersionState: "outdated",
    lastUpdate: null,
    os: "linux",
    arch: "amd64",
    capabilities: [],
    lastSeenAt: new Date().toISOString(),
    online: true,
    connected: true,
    resource: null,
    sessions: [],
    usage: [],
    services: [],
    diagnostics: [],
    gitRootCount: 0,
    listeners: [],
    ...overrides,
  };
}

/** An `updateStatus` frame as the agent reports it, with the pane counts that matter. */
export function mockUpdate(shellPanes: number, sessionPanes: number, overrides: MockHost = {}): MockHost {
  return {
    commandId: "5f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
    phase: "done",
    progressPct: null,
    currentVersion: "1.4.0",
    targetVersion: "1.4.0",
    code: null,
    message: "",
    shellPanes,
    sessionPanes,
    ...overrides,
  };
}
