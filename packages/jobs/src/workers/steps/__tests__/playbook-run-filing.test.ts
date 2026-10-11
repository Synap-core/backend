/**
 * FILING — a session started by an automation's `playbook_run` node carries the
 * node's `projectId` / `trackId`.
 *
 * Without it a worker's session was born unfiled: `automation-executor.ts`
 * rebuilds the node data field-by-field at the TOP LEVEL, the shim never read
 * the fields, and `runPlaybook` (which validates filing) was never handed them.
 *
 * Two halves, because the two executor paths fail differently:
 *   A. BEHAVIOUR — the real `executePlaybookRun` hands the spine `projectId` /
 *      `trackId` (and omits the keys when the node has none).
 *   B. THE TWO CALL SITES in `automation-executor.ts` (top level + loop child).
 *      The loop path passes `childNode.data` WHOLESALE (fields ride along); the
 *      top-level path rebuilds a literal and must forward both explicitly. The
 *      scan is derived from every `executePlaybookRun(` call in the file: a
 *      literal argument must name both fields; a wholesale `.data as {…}` cast
 *      must DECLARE both in its type.
 *
 * NOT COVERED, measured: B reads source text — it cannot see a right key
 * forwarded with a wrong value (`trackId: data.projectId` passes). Appointment
 * mode carries no filing (the scheduler door has no track input).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { runnerMock } = vi.hoisted(() => ({
  runnerMock: vi.fn(async (_input: unknown) => ({
    run: { id: "run-1", status: "running" },
    session: { id: "sess-run", channelId: "chan-1" },
  })),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: { entities: { findFirst: vi.fn(async () => undefined) } },
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  entities: {},
  events: {},
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  verifyPermission: vi.fn(),
}));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: vi.fn(async () => ({
    decision: "not-agent" as const,
  })),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executePlaybookRun } from "../playbook-run.js";
import { registerPlaybookRunner } from "../../capability-dispatch.js";
import type { StepContext } from "../../automation-executor-types.js";

const context = () =>
  ({
    trigger: { payload: {} },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

const spineInput = () => runnerMock.mock.calls[0][0] as Record<string, unknown>;

beforeEach(() => {
  runnerMock.mockClear();
  registerPlaybookRunner(runnerMock as never);
});

describe("A. executePlaybookRun forwards filing to the spine", () => {
  it("projectId + trackId reach runPlaybook", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1", projectId: "proj-1", trackId: "trk-1" },
      context(),
      "ws-1",
      "user-1"
    );
    expect(spineInput().projectId).toBe("proj-1");
    expect(spineInput().trackId).toBe("trk-1");
  });

  it("an unfiled node sends neither key (unchanged for every existing node)", async () => {
    await executePlaybookRun(
      { playbookId: "pb-1" },
      context(),
      "ws-1",
      "user-1"
    );
    expect("projectId" in spineInput()).toBe(false);
    expect("trackId" in spineInput()).toBe(false);
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

describe("B. automation-executor.ts call sites carry filing", () => {
  it("non-vacuity: sees both the top-level and the loop-child call", () => {
    expect(SITES.length).toBe(2);
    expect(SITES.some((s) => s.trimStart().startsWith("{"))).toBe(true); // top level literal
    expect(SITES.some((s) => /childNode\.data\s+as\b/.test(s))).toBe(true); // loop child
  });

  it("every call forwards (literal) or declares (wholesale cast) BOTH fields", () => {
    for (const site of SITES) {
      if (site.trimStart().startsWith("{")) {
        expect(site).toMatch(/\bprojectId:\s*data\.projectId\b/);
        expect(site).toMatch(/\btrackId:\s*data\.trackId\b/);
      } else {
        expect(site).toMatch(/\bprojectId\?:\s*string\b/);
        expect(site).toMatch(/\btrackId\?:\s*string\b/);
      }
    }
  });
});
