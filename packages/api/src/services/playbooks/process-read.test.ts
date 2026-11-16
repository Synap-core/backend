/**
 * THE process read (Process wave plan 0adf8352, W2): composed from existing
 * reads, deriving nothing new, and an unmeasured part is never empty.
 *
 * The pure folds are driven with real playbook shapes; `readProcess` is driven
 * through its real composition with each existing read replaced at its module
 * (the seam this file owns is the composition: which read fills which block,
 * and what a failed read turns into).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  capsFail: false,
  groupsFail: false,
  groups: [] as Array<Record<string, unknown>>,
  marks: [] as Array<Record<string, unknown>>,
  openRows: [] as Array<{ id: string; playbookId: string }>,
  doneRows: [] as Array<{ playbookId: string; n: number }>,
  asksYou: new Set<string>(),
  outside: [] as Array<Record<string, unknown>>,
  outsideFail: false,
}));

vi.mock("../../access/scoped-db.js", () => ({
  scopedDb: () => ({
    findFirst: async () => h.row,
    findMany: async () => (h.row ? [h.row] : []),
    predicate: () => undefined,
  }),
}));
vi.mock("../capabilities/capability-registry.js", () => ({
  listCapabilities: async () => {
    if (h.capsFail) throw new Error("registry down");
    return [
      {
        id: "cap-gh",
        name: "github",
        kind: "tool",
        verbs: [
          { id: "github_pr_checks", intent: "fetch_record", kind: "read" },
        ],
      },
    ];
  },
}));
vi.mock("../capabilities/capability-intent-index.js", async () => ({
  // The real fold over the registry rows above, reduced to what it reads.
  foldIntentCoverage: (input: { declared: string[] }) => ({
    intents: input.declared.map((intent) =>
      intent === "fetch_record"
        ? {
            intent,
            satisfied: true,
            providedBy: [
              {
                capabilityId: "cap-gh",
                capabilityName: "github",
                verbId: "github_pr_checks",
              },
            ],
          }
        : { intent, satisfied: false, providedBy: [] }
    ),
  }),
}));
vi.mock("../runs/index.js", () => ({
  listRunGroupsPage: async () => {
    if (h.groupsFail) throw new Error("ledger down");
    return { groups: h.groups, nextCursor: null };
  },
}));
vi.mock("../runs/recent-by-flows.js", () => ({
  listRecentRunsByFlows: async () => [
    { flowType: "playbook", flowId: "pb-1", runs: h.marks },
  ],
}));
vi.mock("../signals/needs-you-owed.js", () => ({
  asksYouSessionIds: async () => h.asksYou,
}));
vi.mock("./workers.js", () => ({
  listEnabledWorkers: async () => [
    {
      ruleId: "r-1",
      activatorKey: "on-pr",
      mode: "run",
      scope: "space",
      state: "running",
      automationId: "a-act",
      projectId: null,
      trackId: null,
    },
  ],
}));
vi.mock("./playbook-skills.js", () => ({
  readPlaybookSkills: async () => [
    {
      id: "s-1",
      slug: "dev/ship",
      name: "Ship",
      source: "guidance",
      approved: true,
    },
  ],
}));
vi.mock("./pre-approved-run.js", () => ({
  readPreApprovedVersion: async () => 3,
}));
vi.mock("../lifecycle/flow-read.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readFlowOf: async () => ({
      states: [
        { key: "open", label: "Open", category: "open", owners: [] },
        {
          key: "merged",
          label: "Merged",
          category: "done",
          owners: [{ playbookId: "pb-1", stageKey: "merge" }],
        },
      ],
      flows: [{ id: "pb-1", undeclaredStatuses: ["deployed"] }],
    }),
  };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // One query double: `select(...)` → a chain whose terminal answers by the
  // shape asked (grouped done counts, open session ids, automation rows,
  // recent sessions).
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const k of ["from", "innerJoin", "where", "orderBy", "groupBy"])
      c[k] = () => c;
    c.limit = async () => rows();
    c.then = (resolve: (v: unknown) => void) => resolve(rows());
    return c;
  };
  return {
    ...actual,
    db: {
      select: (cols: Record<string, unknown>) =>
        chain(() => {
          if ("n" in cols) return h.doneRows;
          if ("sessionId" in cols) return [];
          if ("triggerType" in cols && "workspaceId" in cols) {
            if (h.outsideFail) throw new Error("automations read failed");
            return h.outside;
          }
          if ("role" in cols)
            return [
              {
                playbookId: "pb-1",
                id: "a-sched",
                name: "Ship a change (schedule)",
                role: "schedule",
                triggerType: "cron",
                status: "active",
                sortOrder: null,
                nextRunAt: null,
              },
              {
                playbookId: "pb-1",
                id: "a-member",
                name: "PR facts",
                role: null,
                triggerType: "event",
                status: "active",
                sortOrder: null,
                nextRunAt: null,
              },
            ];
          return h.openRows;
        }),
    },
  };
});

const {
  coverNeeds,
  declaredNeeds,
  processChecks,
  processSteps,
  readProcess,
  listProcesses,
} = await import("./process-read.js");

const WS = "99999999-9999-4999-8999-999999999999";

const PLAYBOOK = {
  id: "pb-1",
  name: "Ship a change",
  description: null,
  workspaceId: WS,
  status: "active",
  version: 3,
  executor: "is-agent",
  runner: null,
  scope: null,
  subjectProfile: { profileSlug: "change" },
  metadata: {
    marketSource: {
      packageSlug: "builder",
      packageVersion: "h-abc",
      installedAt: "2026-11-01T00:00:00.000Z",
      baseline: {},
    },
  },
  tools: ["synap_get_entity", "fetch_record", "github", "deploy_build"],
  requires: ["media-ffmpeg"],
  criteria: [
    {
      key: "merged",
      statement: "The PR is merged",
      check: { kind: "capability" },
    },
  ],
  stages: [
    { key: "open", name: "Open", category: "started", tools: ["github"] },
    {
      key: "merge",
      name: "Merge",
      category: "done",
      gate: { kind: "human" },
      subjectStatus: "merged",
      requires: ["git"],
      criteria: [
        {
          key: "green",
          statement: "Checks green",
          check: { kind: "evidence" },
        },
      ],
    },
  ],
};

const READER = { userId: "u-1" };

beforeEach(() => {
  h.row = { ...PLAYBOOK };
  h.capsFail = false;
  h.groupsFail = false;
  h.groups = [
    {
      flowType: "playbook",
      flowId: "pb-1",
      runCount: 4,
      latestRunId: "run-4",
      latestStatus: "failed",
      latestStartedAt: new Date("2026-11-15T10:00:00Z"),
      hasRunning: false,
      recentFailedCount: 1,
    },
  ];
  h.marks = [];
  h.openRows = [
    { id: "s-a", playbookId: "pb-1" },
    { id: "s-b", playbookId: "pb-1" },
  ];
  h.doneRows = [{ playbookId: "pb-1", n: 2 }];
  h.asksYou = new Set(["s-b"]);
});

describe("the pure folds", () => {
  it("steps carry each stage's runner, tools, requires, gate and subject status", () => {
    const steps = processSteps(PLAYBOOK as never);
    expect(
      steps.map((s) => [s.key, s.gate, s.subjectStatus, s.requires])
    ).toEqual([
      ["open", null, null, []],
      ["merge", "human", "merged", ["git"]],
    ]);
    expect(steps[0]!.tools).toEqual(["github"]);
    // Who moves each step on comes from the one classifier: the human-gated
    // step waits on a person, the other is worked by an agent.
    expect(steps.map((s) => [s.key, s.runnerKind])).toEqual([
      ["open", "ai"],
      ["merge", "person"],
    ]);
  });

  it("checks are the playbook's and each step's criteria, and the gates", () => {
    const checks = processChecks(PLAYBOOK as never);
    expect(checks.criteria.map((c) => [c.key, c.stepKey, c.checkKind])).toEqual(
      [
        ["merged", null, "capability"],
        ["green", "merge", "evidence"],
      ]
    );
    expect(checks.gates).toEqual([{ stepKey: "merge", kind: "human" }]);
  });

  it("needs: a run tool is not a need; an intent is an intent; the rest are capabilities; requires keys too", () => {
    const needs = declaredNeeds(PLAYBOOK as never);
    expect(needs.map((n) => [n.source, n.slug, n.kind, n.steps])).toEqual([
      ["tools", "fetch_record", "intent", []],
      ["tools", "github", "capability", ["open"]],
      ["tools", "deploy_build", "capability", []],
      ["requires", "media-ffmpeg", "capability", []],
      ["requires", "git", "capability", ["merge"]],
    ]);
  });

  it("coverage: filled by a provider, empty when the registry names none, unknown when unread or a requires key", () => {
    const declared = declaredNeeds(PLAYBOOK as never);
    const caps = [
      { id: "cap-gh", name: "github", verbs: [{ id: "github_pr_checks" }] },
    ] as never;
    const covered = coverNeeds(declared, caps, "ws-1");
    expect(covered.map((n) => [n.slug, n.state])).toEqual([
      ["fetch_record", "filled"],
      ["github", "filled"],
      ["deploy_build", "empty"],
      ["media-ffmpeg", "unknown"],
      ["git", "unknown"],
    ]);
    expect(covered[1]!.providers).toEqual([
      { capabilityId: "cap-gh", capabilityName: "github", verbId: null },
    ]);
    // A failed registry read: every need unmeasured, never "empty".
    expect(
      coverNeeds(declared, null, "ws-1").every((n) => n.state === "unknown")
    ).toBe(true);
  });
});

describe("readProcess — composed from the existing reads", () => {
  it("fills every block from its read", async () => {
    const read = await readProcess(READER, "pb-1");
    expect(read).not.toBeNull();
    expect(read!.playbook).toMatchObject({
      id: "pb-1",
      version: 3,
      scope: "session",
      subjectProfileSlug: "change",
      preApprovedVersion: 3,
      installedFrom: { packageSlug: "builder", packageVersion: "h-abc" },
    });
    expect(read!.when.automations.map((a) => [a.id, a.role])).toEqual([
      ["a-sched", "schedule"],
      ["a-member", "member"],
    ]);
    expect(read!.when.workers.map((w) => w.ruleId)).toEqual(["r-1"]);
    expect(read!.when.manualStart).toBe(true);
    expect(read!.moves).toEqual({
      profileSlug: "change",
      states: [
        { key: "open", label: "Open", category: "open", ownedBy: [] },
        {
          key: "merged",
          label: "Merged",
          category: "done",
          ownedBy: ["merge"],
        },
      ],
      undeclaredStatuses: ["deployed"],
    });
    expect(read!.needs.find((n) => n.slug === "fetch_record")?.state).toBe(
      "filled"
    );
    expect(read!.skills.map((s) => s.source)).toEqual(["guidance"]);
    expect(read!.runs.counts).toEqual({
      open: 2,
      needsYou: 1,
      doneThisWeek: 2,
      failedThisWeek: 1,
      total: 4,
    });
    expect(read!.health).toMatchObject({
      state: "unresolved-failure",
      runId: "run-4",
    });
  });

  it("a failed read is named unavailable and reads unknown / null, never empty", async () => {
    h.capsFail = true;
    h.groupsFail = true;
    const read = await readProcess(READER, "pb-1");
    expect(read!.unavailable).toEqual(
      expect.arrayContaining(["needs", "runs", "health"])
    );
    expect(
      read!.needs
        .filter((n) => n.source === "tools")
        .every((n) => n.state === "unknown")
    ).toBe(true);
    expect(read!.runs.counts.total).toBeNull();
    expect(read!.runs.counts.failedThisWeek).toBeNull();
    // Health with no ledger read is not "never run": unknown.
    expect(read!.health.state).toBe("unknown");
  });

  it("no ledger group for this flow, read complete → exactly never run", async () => {
    h.groups = [];
    const read = await readProcess(READER, "pb-1");
    expect(read!.health.state).toBe("never-run");
    expect(read!.runs.counts.total).toBe(0);
  });

  it("a playbook the reader cannot see is null (the door says not found)", async () => {
    h.row = null;
    expect(await readProcess(READER, "pb-1")).toBeNull();
  });
});

describe("listProcesses — the same reads as cards", () => {
  it("a card carries health, counts, step and automation counts and its needs", async () => {
    const {
      processes: [card],
    } = await listProcesses(READER, { workspaceId: WS });
    expect(card).toMatchObject({
      id: "pb-1",
      stepCount: 2,
      automationCount: 2,
      counts: { open: 2, needsYou: 1, total: 4 },
      health: { state: "unresolved-failure" },
    });
    expect(card!.needs.map((n) => [n.slug, n.state])).toContainEqual([
      "deploy_build",
      "empty",
    ]);
  });
});

describe("listProcesses — the automations outside any process", () => {
  beforeEach(() => {
    h.outside = [];
    h.outsideFail = false;
  });

  it("returns the automations in no process next to the cards", async () => {
    h.outside = [
      {
        id: "a-loose",
        name: "Weekly digest",
        triggerType: "cron",
        status: "active",
        workspaceId: null,
      },
    ];
    const index = await listProcesses(READER, { workspaceId: WS });
    expect(index.processes.map((p) => p.id)).toEqual(["pb-1"]);
    expect(index.automationsOutsideProcess).toEqual([
      {
        id: "a-loose",
        name: "Weekly digest",
        triggerType: "cron",
        status: "active",
        workspaceId: null,
      },
    ]);
    expect(index.unavailable).toEqual([]);
  });

  it("none outside is an empty list, a read that read nothing", async () => {
    const index = await listProcesses(READER, { workspaceId: WS });
    expect(index.automationsOutsideProcess).toEqual([]);
    expect(index.unavailable).toEqual([]);
  });

  it("a failed read is null and named unavailable, never an empty list; the cards still come", async () => {
    h.outsideFail = true;
    const index = await listProcesses(READER, { workspaceId: WS });
    expect(index.automationsOutsideProcess).toBeNull();
    expect(index.unavailable).toEqual(["when"]);
    expect(index.processes).toHaveLength(1);
  });
});
