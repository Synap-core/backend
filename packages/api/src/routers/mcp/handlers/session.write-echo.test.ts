/**
 * REPLY SHAPING — the MCP session WRITE doors echo what an agent acts on, never
 * the whole row (`session-write-echo.ts`).
 *
 * Driven through the real handlers (`synap_start_session`,
 * `synap_update_session`, `synap_complete_session`, `synap_evaluate_session`)
 * over a full-width fixture row. Stubbed at their module seams: the services
 * (governance and a database), the nudge loader and the offer stamp. What is
 * under test is the reply: the fields kept (the bridge reads `session.id` from
 * a start and `blockerLinks` from an update), and the bulk left out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  complete: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock("../../../services/focus-sessions/create-session.js", () => ({
  createFocusSession: h.create,
}));
vi.mock("../../../services/focus-sessions/update-session.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, updateFocusSession: h.update };
});
vi.mock(
  "../../../services/focus-sessions/complete-session.js",
  async (orig) => {
    const actual = await orig<Record<string, unknown>>();
    return { ...actual, completeFocusSession: h.complete };
  }
);
vi.mock(
  "../../../services/focus-sessions/evaluations/evaluate.js",
  async (orig) => {
    const actual = await orig<Record<string, unknown>>();
    return { ...actual, evaluateSession: h.evaluate };
  }
);
vi.mock("../../../services/focus-sessions/session-nudges.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    loadSessionNudges: async () => null,
    claimPlaybookOffer: async () => true,
  };
});

import { sessionHandlers } from "./session.js";
import { sessionEvaluationHandlers } from "./session-evaluation.js";
import { SESSION_ECHO_FIELDS, sessionWriteEcho } from "./session-write-echo.js";
import type { McpToolContext } from "./shared.js";

const SID = "11111111-2222-4333-8444-555555555555";
const ROOM = "66666666-2222-4333-8444-555555555555";

/** A row as wide as the real one: the bulk an echo must leave out. */
function fullRow(): Record<string, unknown> {
  return {
    id: SID,
    userId: "11111111-1111-4111-8111-111111111111",
    workspaceId: null,
    projectId: "77777777-2222-4333-8444-555555555555",
    trackId: "88888888-2222-4333-8444-555555555555",
    trackStage: null,
    origin: "agent",
    subjectEntityId: null,
    correlationId: null,
    title: "Slim the replies",
    goal: "Agents get write replies carrying only what they act on, ".repeat(4),
    status: "active",
    templateId: null,
    playbookId: null,
    expectedOutputs: [
      {
        key: "draft-pr",
        kind: "pull_request",
        label: "Draft PR",
        status: "pending",
        why: "w".repeat(200),
      },
      {
        key: "ask-scope",
        kind: "decision",
        label: "Scope",
        status: "pending",
        owner: "human",
        ask: { mode: "confirm", prompt: "p".repeat(300) },
      },
    ],
    channelId: ROOM,
    progress: 40,
    currentStage: "build",
    stageHistory: [{ stage: "plan", at: "2026-11-05T10:00:00Z" }],
    agentIds: ["22222222-2222-4222-8222-222222222222"],
    closedAt: null,
    verificationReport: null,
    criteria: [
      { key: "tsc", statement: "s".repeat(200), check: { kind: "evidence" } },
    ],
    stages: [
      { key: "plan", name: "Plan", goal: "g".repeat(200) },
      { key: "build", name: "Build", goal: "g".repeat(200) },
    ],
    metadata: { recall: { items: ["x".repeat(500)] }, run: { a: 1 } },
    startedAt: "2026-11-05T09:00:00Z",
    createdAt: "2026-11-05T09:00:00Z",
    updatedAt: "2026-11-05T13:00:00Z",
  };
}

/** Never in an echo: what the agent sent itself, or never reads on a write. */
const LEFT_OUT = [
  "goal",
  "metadata",
  "stages",
  "stageHistory",
  "criteria",
  "expectedOutputs",
  "verificationReport",
  "userId",
  "agentIds",
];

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  return {
    toolName,
    args,
    userId: "11111111-1111-4111-8111-111111111111",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "22222222-2222-4222-8222-222222222222",
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  };
}

const body = (r: { content?: unknown[] }) =>
  JSON.parse((r.content![0] as { text: string }).text) as Record<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >;

const chars = (o: unknown) => JSON.stringify(o).length;

beforeEach(() => {
  h.create.mockReset();
  h.update.mockReset();
  h.complete.mockReset();
  h.evaluate.mockReset();
});

describe("sessionWriteEcho", () => {
  it("keeps the identity and state fields, and only those", () => {
    const echo = sessionWriteEcho(fullRow());
    expect(Object.keys(echo)).toEqual([...SESSION_ECHO_FIELDS]);
    expect(echo).toMatchObject({
      id: SID,
      channelId: ROOM,
      status: "active",
      currentStage: "build",
      progress: 40,
    });
  });

  it("a start adds the outcome and criterion KEYS, not their texts", () => {
    const echo = sessionWriteEcho(fullRow(), { withKeys: true });
    expect(echo.outcomes).toEqual([
      { key: "draft-pr", label: "Draft PR", status: "pending" },
      { key: "ask-scope", label: "Scope", status: "pending", owner: "human" },
    ]);
    expect(echo.criteria).toEqual(["tsc"]);
  });

  it("a start from a staged session carries the stage keys in order; an unstaged one has no stages field", () => {
    expect(sessionWriteEcho(fullRow(), { withKeys: true }).stages).toEqual([
      "plan",
      "build",
    ]);
    const unstaged = sessionWriteEcho(
      { ...fullRow(), stages: [] },
      { withKeys: true }
    );
    expect(unstaged).not.toHaveProperty("stages");
    // update and complete echoes never carry the list
    expect(sessionWriteEcho(fullRow())).not.toHaveProperty("stages");
  });

  it("never invents a field the row does not carry", () => {
    expect(sessionWriteEcho({ id: SID })).toEqual({ id: SID });
  });
});

describe("synap_update_session echoes, never the whole row", () => {
  it("the reply's session is the echo; status, completeOutput and warnings stay", async () => {
    h.update.mockResolvedValue({
      status: "updated",
      session: fullRow(),
      completeOutput: { key: "draft-pr", result: "claimed" },
      warnings: ["an ask on an agent slot was dropped"],
    });
    const r = body(
      await sessionHandlers.synap_update_session!(
        ctx("synap_update_session", { sessionId: SID, progress: 40 })
      )
    );
    expect(r.status).toBe("updated");
    expect(r.session).toEqual(sessionWriteEcho(fullRow()));
    for (const f of LEFT_OUT) expect(r.session).not.toHaveProperty(f);
    expect(r.completeOutput).toEqual({ key: "draft-pr", result: "claimed" });
    expect(r.warnings).toEqual(["an ask on an agent slot was dropped"]);
    // MEASURED on this fixture: the echo is a fraction of the row.
    expect(chars(r.session)).toBeLessThan(chars(fullRow()) / 4);
  });
});

describe("synap_complete_session echoes, never the whole closed row", () => {
  it("status, counts and the echo; no row bulk", async () => {
    h.complete.mockResolvedValue({
      session: {
        ...fullRow(),
        status: "closed",
        closedAt: "2026-11-05T14:00Z",
      },
      pendingProposals: [],
      counts: {
        pending: 0,
        unfinishedOutputs: 0,
        expiredEphemerals: 0,
        retiredSlots: 0,
        closedQuestions: 0,
      },
      warnings: [],
    });
    const r = body(
      await sessionHandlers.synap_complete_session!(
        ctx("synap_complete_session", { sessionId: SID })
      )
    );
    expect(r.status).toBe("closed");
    expect(r.session).toMatchObject({ id: SID, status: "closed" });
    for (const f of LEFT_OUT) expect(r.session).not.toHaveProperty(f);
    expect(r.counts.pending).toBe(0);
  });
});

describe("synap_start_session echoes, with the keys", () => {
  it("a created session: the id the bridge binds, the room, the keys", async () => {
    h.create.mockResolvedValue({ status: "created", session: fullRow() });
    const r = body(
      await sessionHandlers.synap_start_session!(
        ctx("synap_start_session", {
          goal: "Slim the replies",
          templateId: null,
          criteria: [
            { key: "tsc", statement: "tsc clean", check: { kind: "evidence" } },
          ],
        })
      )
    );
    expect(r.status).toBe("created");
    // synap-bridge `startedSessionId` reads exactly this.
    expect(r.session.id).toBe(SID);
    expect(r.session.channelId).toBe(ROOM);
    expect(r.session.outcomes.map((o: { key: string }) => o.key)).toEqual([
      "draft-pr",
      "ask-scope",
    ]);
    // Keys only, never the statements the agent sent.
    expect(r.session.criteria).toEqual(["tsc"]);
    // The fixture row is staged: the start names the stage keys, in order.
    expect(r.session.stages).toEqual(["plan", "build"]);
    for (const f of LEFT_OUT.filter((f) => f !== "criteria" && f !== "stages"))
      expect(r.session).not.toHaveProperty(f);
  });

  it("CONTROL — a deduped start hands back the existing row whole (work the agent did not write)", async () => {
    h.create.mockResolvedValue({
      status: "deduped",
      session: fullRow(),
      candidates: [],
    });
    const r = body(
      await sessionHandlers.synap_start_session!(
        ctx("synap_start_session", {
          goal: "Slim the replies",
          templateId: null,
          criteria: [
            { key: "tsc", statement: "tsc clean", check: { kind: "evidence" } },
          ],
        })
      )
    );
    expect(r.status).toBe("deduped");
    expect(r.session.goal).toBe(fullRow().goal);
  });
});

describe("synap_evaluate_session: verdicts, not the declaration echoed", () => {
  it("drops `criteria` and slims each evaluation to what the agent acts on", async () => {
    h.evaluate.mockResolvedValue({
      status: "evaluated",
      results: [{ key: "tsc", status: "recorded", verdict: "fail" }],
      resumed: false,
      criteria: fullRow().criteria,
      evaluations: [
        {
          id: "e1",
          sessionId: SID,
          userId: "u",
          workspaceId: null,
          criterionKey: "tsc",
          attempt: 2,
          verdict: "fail",
          evaluatorKind: "judge",
          evaluatorId: "model-x",
          evidence: { tsc: { passed: false, detail: "d".repeat(400) } },
          rationale: "3 errors remain",
          createdAt: "2026-11-05T13:00:00Z",
        },
      ],
      verdict: { status: "fail" },
    });
    const r = body(
      await sessionEvaluationHandlers.synap_evaluate_session!(
        ctx("synap_evaluate_session", { sessionId: SID })
      )
    );
    expect(r).not.toHaveProperty("criteria");
    expect(r.evaluations).toEqual([
      {
        criterionKey: "tsc",
        verdict: "fail",
        evaluatorKind: "judge",
        attempt: 2,
        rationale: "3 errors remain",
      },
    ]);
    expect(r.results).toEqual([
      { key: "tsc", status: "recorded", verdict: "fail" },
    ]);
    expect(r.verdict).toEqual({ status: "fail" });
  });
});
