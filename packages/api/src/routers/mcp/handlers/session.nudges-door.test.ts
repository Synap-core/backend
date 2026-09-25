/**
 * The MCP session doors CARRY the nudges — driven through the real handlers.
 *
 * Real: `synap_update_session` / `synap_complete_session` (their reply shaping),
 * `loadSessionNudges`, `computeSessionNudges`, `summarizeEvaluations`.
 * Stubbed, and why: `updateFocusSession` / `completeFocusSession` (governance +
 * a database; the reply shape is what is under test, and both return the row
 * the loader reads), the evaluation-row READ (`loadSessionEvaluationSummary`
 * re-wired onto the REAL `summarizeEvaluations` over fixture rows, so the
 * current-row decision stays the shared one), and the playbook matcher + offer
 * stamp (their own module; the once-only rule is pinned in the pure test and
 * the stamp's WHERE clause).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  evalRows: [] as unknown[],
  matchCalls: 0,
}));

vi.mock("../../../services/focus-sessions/update-session.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    updateFocusSession: async () => ({ status: "updated", session: h.session }),
  };
});
vi.mock(
  "../../../services/focus-sessions/complete-session.js",
  async (orig) => {
    const actual = await orig<Record<string, unknown>>();
    return {
      ...actual,
      completeFocusSession: async () => ({
        session: { ...h.session, status: "closed" },
        pendingProposals: [],
        counts: {
          pending: 0,
          unfinishedOutputs: 0,
          expiredEphemerals: 0,
          retiredSlots: 0,
        },
        warnings: [],
      }),
    };
  }
);
vi.mock(
  "../../../services/focus-sessions/evaluations/record.js",
  async (orig) => {
    const actual = await orig<{
      summarizeEvaluations: (c: unknown, r: unknown[]) => unknown;
    }>();
    return {
      ...actual,
      loadSessionEvaluationSummary: async (s: { criteria: unknown }) =>
        actual.summarizeEvaluations(s.criteria, h.evalRows),
    };
  }
);
vi.mock(
  "../../../services/focus-sessions/match-session-template.js",
  async (orig) => {
    const actual = await orig<Record<string, unknown>>();
    return {
      ...actual,
      matchSessionTemplate: async () => {
        h.matchCalls++;
        return {
          candidates: [
            { id: "pb-1", name: "Ship a release", score: 3, reason: "x" },
          ],
          optOut: "pass templateId: null",
        };
      },
    };
  }
);

import { sessionHandlers } from "./session.js";

const SID = "11111111-2222-4333-8444-555555555555";

const ctx = (toolName: string, args: Record<string, unknown>) =>
  ({
    toolName,
    args,
    userId: "u1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "agent-1",
  }) as never;

const body = (r: { content: unknown[] }) =>
  JSON.parse((r.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  h.matchCalls = 0;
  h.evalRows = [];
  h.session = {
    id: SID,
    userId: "u1",
    workspaceId: null,
    title: "Ship W5",
    goal: "Ship W5",
    status: "active",
    // Bound: no playbook offer, so the door test never reaches the stamp.
    playbookId: "pb-bound",
    origin: "playbook",
    currentStage: null,
    stages: [
      { key: "plan", name: "Plan" },
      { key: "ship", name: "Ship" },
    ],
    expectedOutputs: [],
    metadata: {},
    criteria: [
      { key: "tsc", statement: "tsc clean", check: { kind: "evidence" } },
      { key: "tests", statement: "tests pass", check: { kind: "evidence" } },
    ],
  };
});

describe("MCP update_session carries nudges", () => {
  it("ungraded criteria + unset stage ride the SUCCESS reply", async () => {
    h.evalRows = [
      {
        criterionKey: "tsc",
        verdict: "pass",
        evaluatorKind: "evidence",
        createdAt: new Date(),
      },
    ];
    const r = body(
      await sessionHandlers.synap_update_session!(
        ctx("synap_update_session", { sessionId: SID, progress: 40 })
      )
    );
    expect(r.status).toBe("updated");
    expect(r.nudges).toMatchObject({
      ungradedCriteria: ["tests"],
      stage: { state: "unset", current: null, stages: ["plan", "ship"] },
    });
    expect(h.matchCalls).toBe(0);
  });

  it("nothing owed ⇒ no `nudges` key at all (absence says zero)", async () => {
    h.session.currentStage = "plan";
    h.evalRows = ["tsc", "tests"].map((k) => ({
      criterionKey: k,
      verdict: "pass",
      evaluatorKind: "evidence",
      createdAt: new Date(),
    }));
    const r = body(
      await sessionHandlers.synap_update_session!(
        ctx("synap_update_session", { sessionId: SID, progress: 40 })
      )
    );
    expect(r.status).toBe("updated");
    expect("nudges" in r).toBe(false);
  });
});

describe("MCP complete_session carries nudges and never blocks", () => {
  it("closes AND reports what closed ungraded / short of the last stage", async () => {
    h.session.currentStage = "plan";
    const r = body(
      await sessionHandlers.synap_complete_session!(
        ctx("synap_complete_session", { sessionId: SID })
      )
    );
    expect(r.status).toBe("closed");
    expect(r.nudges).toMatchObject({
      ungradedCriteria: ["tsc", "tests"],
      stage: { state: "not_final", current: "plan" },
    });
  });
});
