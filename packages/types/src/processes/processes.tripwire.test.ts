/**
 * TRIPWIRE — the Process leaf keeps its rule whole.
 *
 *  1. Every PROCESS_HEALTH_STATES member is REACHABLE from deriveProcessHealth
 *     (a state no input produces is a dead word a surface would still design
 *     for), and the rule produces no state outside the list.
 *  2. Every section of a ProcessRead is either a block (PROCESS_BLOCKS) or one
 *     of its three headers (playbook, health, unavailable): a new section must
 *     join the block order or every surface would place it on its own. The
 *     fixture is typed `ProcessRead`, so a new required section fails tsc
 *     until it is added here, and then this test until it gets a place.
 *  3. Each block's "empty" answer reads the block it names, and a block whose
 *     read failed is never empty (a failed read is not an empty one).
 *  4. The leaf has an EXPLICIT exports entry: relay's walk and tsconfig, and
 *     the Vite/Metro aliases, resolve only exact keys (main red cfa4008f2).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROCESS_BLOCKS,
  PROCESS_HEALTH_STATES,
  PROCESS_READ_PARTS,
  countProcessNeeds,
  deriveProcessHealth,
  processBlockIsEmpty,
  processNeedsReady,
  unmeasuredProcessRunCounts,
  type ProcessHealthInput,
  type ProcessRead,
} from "./index.js";

const at = (h: number) => new Date(Date.UTC(2026, 6, 30, h));
const mark = (id: string, status: string, h: number) => ({
  id,
  status,
  startedAt: at(h),
});

/** One input per path through the rule. */
const INPUTS: ProcessHealthInput[] = [
  {
    definitionStatus: "error",
    runGroup: null,
    recentRuns: [],
    exactRunCount: 0,
  },
  {
    definitionStatus: "active",
    runGroup: null,
    recentRuns: [mark("a", "failed", 1)],
    exactRunCount: 1,
  },
  {
    definitionStatus: "active",
    runGroup: null,
    recentRuns: [mark("a", "blocked_by_policy", 1)],
    exactRunCount: 1,
  },
  {
    definitionStatus: "active",
    runGroup: null,
    recentRuns: [mark("a", "waiting_on_you", 1)],
    exactRunCount: 1,
  },
  {
    definitionStatus: "active",
    runGroup: null,
    recentRuns: [mark("a", "running", 1)],
    exactRunCount: 1,
  },
  {
    definitionStatus: "draft",
    runGroup: null,
    recentRuns: [],
    exactRunCount: 0,
  },
  {
    definitionStatus: "paused",
    runGroup: null,
    recentRuns: [],
    exactRunCount: 0,
  },
  {
    definitionStatus: "archived",
    runGroup: null,
    recentRuns: [],
    exactRunCount: 0,
  },
  {
    definitionStatus: "active",
    runGroup: null,
    recentRuns: [mark("a", "completed", 1)],
    exactRunCount: 1,
  },
  {
    definitionStatus: "active",
    runGroup: null,
    recentRuns: [],
    exactRunCount: 0,
  },
  {
    definitionStatus: "active",
    runGroup: null,
    recentRuns: [],
    exactRunCount: null,
  },
  {
    definitionStatus: "active",
    runGroup: null,
    recentRuns: [mark("a", "proposed", 1)],
    exactRunCount: 1,
  },
];

const health = deriveProcessHealth(INPUTS[0]!);

const FIXTURE: ProcessRead = {
  playbook: {
    id: "p",
    name: "Ship a change",
    description: null,
    workspaceId: null,
    status: "active",
    version: 1,
    executor: "is-agent",
    runner: null,
    scope: "session",
    subjectProfileSlug: null,
    preApprovedVersion: null,
    installedFrom: null,
    updateAvailable: null,
  },
  when: { automations: [], workers: [], manualStart: false },
  steps: [],
  checks: { criteria: [], gates: [] },
  moves: null,
  needs: [],
  skills: [],
  runs: { counts: unmeasuredProcessRunCounts(), recent: [] },
  health,
  unavailable: [],
};

const HEADERS = ["playbook", "health", "unavailable"];

describe("processes leaf", () => {
  it("every health state is reachable, and none is produced outside the list", () => {
    const produced = new Set(INPUTS.map((i) => deriveProcessHealth(i).state));
    expect([...produced].sort()).toEqual([...PROCESS_HEALTH_STATES].sort());
  });

  it("every ProcessRead section is a block or a header", () => {
    const sections = Object.keys(FIXTURE).filter((k) => !HEADERS.includes(k));
    expect(sections.sort()).toEqual([...PROCESS_BLOCKS].sort());
  });

  it("an empty read is empty in every block; a filled block is not", () => {
    for (const b of PROCESS_BLOCKS) {
      expect(processBlockIsEmpty(FIXTURE, b)).toBe(true);
    }
    const filled: ProcessRead = {
      ...FIXTURE,
      when: { ...FIXTURE.when, manualStart: true },
      steps: [
        {
          key: "s",
          name: "S",
          goal: null,
          category: "started",
          runner: null,
          tools: [],
          requires: [],
          gate: "human",
          subjectStatus: null,
        },
      ],
      checks: { criteria: [], gates: [{ stepKey: "s", kind: "human" }] },
      moves: { profileSlug: "feature", states: [], undeclaredStatuses: [] },
      needs: [
        {
          slug: "x",
          kind: "intent",
          source: "tools",
          state: "unknown",
          providers: [],
          steps: [],
        },
      ],
      skills: [
        { id: null, slug: "s", name: "s", source: "guidance", approved: null },
      ],
      runs: {
        counts: { ...unmeasuredProcessRunCounts(), total: 3 },
        recent: [],
      },
    };
    for (const b of PROCESS_BLOCKS) {
      expect(processBlockIsEmpty(filled, b)).toBe(false);
    }
  });

  it("a block whose read failed is never empty", () => {
    for (const b of PROCESS_BLOCKS) {
      if (!(PROCESS_READ_PARTS as readonly string[]).includes(b)) continue;
      const failed = { ...FIXTURE, unavailable: [b] } as ProcessRead;
      expect(processBlockIsEmpty(failed, b)).toBe(false);
    }
  });

  it("an unmeasured need makes readiness unknown, an empty one makes it false", () => {
    expect(
      countProcessNeeds([{ state: "filled" }, { state: "unknown" }])
    ).toEqual({
      filled: 1,
      empty: 0,
      unknown: 1,
    });
    expect(processNeedsReady([{ state: "filled" }])).toBe(true);
    expect(
      processNeedsReady([{ state: "filled" }, { state: "unknown" }])
    ).toBeNull();
    expect(processNeedsReady([{ state: "unknown" }, { state: "empty" }])).toBe(
      false
    );
    expect(processNeedsReady([])).toBe(true);
  });

  it("the leaf has an explicit exports entry", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")
    ) as { exports: Record<string, { types: string; import: string }> };
    expect(pkg.exports["./processes"]).toEqual({
      types: "./dist/processes/index.d.ts",
      import: "./dist/processes/index.js",
    });
  });
});
