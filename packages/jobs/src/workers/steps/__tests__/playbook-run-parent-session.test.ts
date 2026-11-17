/**
 * A SESSION STARTS A WORKER — a `playbook_run` node's `parentSessionId` makes
 * every run it starts a CHILD of that session (`spawned_from`, written by the
 * spine's `recordSessionSpawn`), and stops it once that session is closed.
 *
 *   A. BEHAVIOUR — the real `executePlaybookRun`:
 *      - hands the runner slot `parentSessionId` (run mode) and the proposal
 *        door `parentSessionId` (propose mode, replayed on approval);
 *      - omits the key for a node with none (every existing node unchanged);
 *      - starts and files NOTHING when the parent is closed or gone
 *        (`session_closed`), in run AND propose mode;
 *      - refuses the pair with `appointment` by name (the scheduler has no
 *        parent input).
 *   B. THE TWO CALL SITES in `automation-executor.ts`: the top-level literal
 *      forwards `parentSessionId: data.parentSessionId`; the loop-child
 *      wholesale cast declares `parentSessionId?: string`.
 *
 * NEGATIVE CONTROLS: "parentSessionId reaches the runner" fails when the step
 * drops the key (the runner input has no `parentSessionId`); "a CLOSED parent
 * starts nothing" fails when the gate is removed (the runner is called); B
 * fails when the top-level forward line is removed.
 *
 * NOT COVERED, measured: B reads source text (a right key with a wrong value
 * passes). The `spawned_from` edge itself is the spine's, proven by
 * `recordSessionSpawn`'s own tests.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  runnerMock: vi.fn(async (_input: unknown) => ({
    run: { id: "run-1", status: "running" },
    session: { id: "sess-run", channelId: "chan-1" },
  })),
  proposeMock: vi.fn(async (_input: unknown) => ({
    proposalId: "prop-1",
    deduped: false,
  })),
  // The parent session's row (`db.query.focusSessions.findFirst`).
  parent: { status: "active" } as { status: string } | undefined,
}));

vi.mock("@synap/database", () => ({
  db: {
    query: {
      entities: { findFirst: vi.fn(async () => undefined) },
      focusSessions: { findFirst: vi.fn(async () => h.parent) },
    },
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  entities: {},
  events: {},
  focusSessions: {},
  countWorkerPendingApprovals: vi.fn(async () => 0),
  WORKER_HELD_OUTPUT_KEY: "held",
}));
vi.mock("../../../utils/automation-governance.js", () => ({
  guardProducerEffect: vi.fn(async () => ({ proceed: true })),
  PolicyBlockedError: class extends Error {},
  proposeRulePlaybookRun: h.proposeMock,
}));
vi.mock("../../../utils/run-in-flight.js", () => ({
  findInFlightRunSession: vi.fn(async () => null),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executePlaybookRun } from "../playbook-run.js";
import {
  registerPlaybookReadinessGate,
  registerPlaybookRunner,
} from "../../capability-dispatch.js";
import type { StepContext } from "../../automation-executor-types.js";

const PARENT = "11111111-1111-4111-8111-111111111111";
const AUTOMATION = {
  automationRunId: "arun-1",
  automationId: "auto-1",
  chainDepth: 0,
};

const context = () =>
  ({
    trigger: { payload: {} },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

const runnerInput = () =>
  h.runnerMock.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  h.runnerMock.mockClear();
  h.proposeMock.mockClear();
  h.parent = { status: "active" };
  registerPlaybookRunner(h.runnerMock as never);
  registerPlaybookReadinessGate((async () => ({ ready: true })) as never);
});

describe("A. executePlaybookRun — a session's worker files its runs under the session", () => {
  it("parentSessionId reaches the runner slot (run mode)", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1", parentSessionId: PARENT },
      context(),
      "ws-1",
      "user-1",
      AUTOMATION
    );
    expect(runnerInput().parentSessionId).toBe(PARENT);
  });

  it("a node with no parent sends no key (unchanged for every existing node)", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1" },
      context(),
      "ws-1",
      "user-1",
      AUTOMATION
    );
    expect("parentSessionId" in runnerInput()).toBe(false);
  });

  it("parentSessionId rides the proposal (propose mode), so the approved run is the session's child", async () => {
    const out = await executePlaybookRun(
      { playbookId: "pb-1", mode: "propose", parentSessionId: PARENT },
      context(),
      "ws-1",
      "user-1",
      AUTOMATION
    );
    expect(out).toMatchObject({ status: "proposed" });
    expect(h.proposeMock.mock.calls[0]![0]).toMatchObject({
      parentSessionId: PARENT,
    });
    expect(h.runnerMock).not.toHaveBeenCalled();
  });

  for (const status of ["closed", "cancelled", "failed"]) {
    it(`a ${status.toUpperCase()} parent starts nothing and files nothing`, async () => {
      h.parent = { status };
      for (const mode of [undefined, "propose"] as const) {
        const out = await executePlaybookRun(
          { playbookId: "pb-1", parentSessionId: PARENT, mode },
          context(),
          "ws-1",
          "user-1",
          AUTOMATION
        );
        expect(out).toEqual({
          status: "skipped",
          reason: "session_closed",
          parentSessionId: PARENT,
        });
      }
      expect(h.runnerMock).not.toHaveBeenCalled();
      expect(h.proposeMock).not.toHaveBeenCalled();
    });
  }

  it("a parent that is gone (or not a uuid) reads as closed", async () => {
    h.parent = undefined;
    expect(
      await executePlaybookRun(
        { playbookId: "pb-1", parentSessionId: PARENT },
        context(),
        "ws-1",
        "user-1",
        AUTOMATION
      )
    ).toMatchObject({ status: "skipped", reason: "session_closed" });
    h.parent = { status: "active" };
    expect(
      await executePlaybookRun(
        { playbookId: "pb-1", parentSessionId: "not-a-uuid" },
        context(),
        "ws-1",
        "user-1",
        AUTOMATION
      )
    ).toMatchObject({ status: "skipped", reason: "session_closed" });
    expect(h.runnerMock).not.toHaveBeenCalled();
  });

  it("an appointment cannot carry a parent: refused by name, nothing started", async () => {
    await expect(
      executePlaybookRun(
        { playbookId: "pb-1", parentSessionId: PARENT, mode: "appointment" },
        context(),
        "ws-1",
        "user-1",
        AUTOMATION
      )
    ).rejects.toThrow(/parentSessionId.*appointment/);
    expect(h.runnerMock).not.toHaveBeenCalled();
  });
});

// ── B. the executor's two call sites ────────────────────────────────────────
const EXECUTOR = readFileSync(
  join(__dirname, "..", "..", "automation-executor.ts"),
  "utf8"
);

/** Text of the first argument of the call whose `(` is at `open`. */
function firstArg(src: string, open: number): string {
  let i = open;
  while (/\s/.test(src[i]!)) i++;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) {
      if (depth === 0) return src.slice(i, j);
      depth--;
    } else if (c === "," && depth === 0) return src.slice(i, j);
  }
  return src.slice(i);
}

const SITES = [...EXECUTOR.matchAll(/\bexecutePlaybookRun\(/g)].map((m) =>
  firstArg(EXECUTOR, m.index! + m[0].length)
);

describe("B. automation-executor.ts call sites carry the parent session", () => {
  it("non-vacuity: sees both the top-level and the loop-child call", () => {
    expect(SITES.length).toBe(2);
    expect(SITES.some((s) => s.trimStart().startsWith("{"))).toBe(true);
    expect(SITES.some((s) => /childNode\.data\s+as\b/.test(s))).toBe(true);
  });

  it("the literal forwards it; the wholesale cast declares it", () => {
    for (const site of SITES) {
      if (site.trimStart().startsWith("{")) {
        expect(site).toMatch(/\bparentSessionId:\s*data\.parentSessionId\b/);
      } else {
        expect(site).toMatch(/\bparentSessionId\?:\s*string\b/);
      }
    }
  });
});
