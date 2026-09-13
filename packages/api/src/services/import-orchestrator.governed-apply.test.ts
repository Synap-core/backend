/**
 * import.apply through the governed door — the refusal floor, and the run
 * session an analyze settles on after its duplicate lookup.
 *
 * `applyThroughApproval` (review must-fix 5 + decision A):
 *  - ONE answer ("Import proposal X not found") for a missing row, a non-import
 *    proposal, and a proposal the principal may not approve — decided BEFORE the
 *    status is read, so the door leaks neither existence nor state;
 *  - an AGENT key is the principal handed to review authority (which refuses an
 *    agent on approve): approval is the human step.
 *
 * `settleRunSession` (must-fix 1): a re-sent analyze reuses the PRIOR proposal's
 * session when the caller owns it, gets NO session when the prior had none or
 * the caller does not own it, and only mints when there is no prior at all.
 *
 * Stubbed, and why: the proposal read, review authority, the approval door and
 * the ownership query — this proves the ORDER and the principal, not their
 * internals (each has its own suite). The Hub door passing `agentUserId` is a
 * source check.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  canReview: vi.fn(),
  apply: vi.fn(),
  verify: vi.fn(),
  resolveImportSession: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      ...(actual.db as object),
      query: { proposals: { findFirst: h.findFirst } },
    },
  };
});
vi.mock("../routers/proposals/review-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeCanReviewApproval: h.canReview,
}));
vi.mock("../routers/proposals/apply-approval.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyProposalApproval: h.apply,
}));
vi.mock(
  "../routers/hub-protocol/_middleware/session.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveVerifiedSessionId: h.verify,
  })
);
vi.mock("./import/session.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveImportSession: h.resolveImportSession,
}));

import { ImportOrchestrator } from "./import-orchestrator.js";

const HUMAN = "human-1";
const AGENT = "agent-1";
const PID = "11111111-1111-4111-8111-111111111111";

type Governed = {
  applyThroughApproval: (
    id: string,
    input: { source: string }
  ) => Promise<unknown>;
  settleRunSession: (
    input: unknown,
    tablePlan: null,
    prior: { sessionId: string | null } | null,
    phase1: { requestedSessionIgnored: boolean }
  ) => Promise<{ sessionId: string | null; sessionSource: string }>;
};

function orchestrator(trpcCtx: Record<string, unknown> = {}) {
  return new ImportOrchestrator({
    workspaceId: null,
    userId: HUMAN,
    trpcCtx,
  }) as unknown as Governed;
}

const importProposal = (over: Record<string, unknown> = {}) => ({
  id: PID,
  proposalType: "import.graph",
  status: "pending",
  workspaceId: null,
  sessionId: null,
  agentUserId: null,
  data: {
    operations: [
      { op: "create_entity", ref: "a", profileSlug: "note", title: "A" },
    ],
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.canReview.mockImplementation(async ({ userId }: { userId: string }) => ({
    allowed: userId === HUMAN,
    reason: userId === HUMAN ? "owner" : "agent",
  }));
  h.apply.mockResolvedValue({ success: true, created: 0, linked: 0 });
});

describe("applyThroughApproval — one refusal, authority first", () => {
  const NOT_FOUND = `Import proposal ${PID} not found`;

  it("a missing proposal answers not found", async () => {
    h.findFirst.mockResolvedValue(undefined);
    await expect(
      orchestrator().applyThroughApproval(PID, { source: "markdown" })
    ).rejects.toThrow(NOT_FOUND);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("a proposal that is not an import answers the SAME not found, before any authority check", async () => {
    h.findFirst.mockResolvedValue(
      importProposal({ proposalType: "capture.graph" })
    );
    await expect(
      orchestrator().applyThroughApproval(PID, { source: "markdown" })
    ).rejects.toThrow(NOT_FOUND);
    expect(h.canReview).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("an AGENT key is the principal, is refused, and learns nothing about the row's status", async () => {
    // Status is NOT pending: a status check before authority would say so.
    h.findFirst.mockResolvedValue(importProposal({ status: "approved" }));
    await expect(
      orchestrator({ agentUserId: AGENT }).applyThroughApproval(PID, {
        source: "markdown",
      })
    ).rejects.toThrow(NOT_FOUND);
    expect(h.canReview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: AGENT, purpose: "approve" })
    );
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("an authorized human applies a pending import through the approval door", async () => {
    h.findFirst.mockResolvedValue(importProposal());
    const result = await orchestrator().applyThroughApproval(PID, {
      source: "markdown",
    });
    expect(h.canReview).toHaveBeenCalledWith(
      expect.objectContaining({ userId: HUMAN })
    );
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ proposalId: PID, governed: true });
  });

  it("only an AUTHORIZED caller hears 'not pending'", async () => {
    h.findFirst.mockResolvedValue(importProposal({ status: "approved" }));
    await expect(
      orchestrator().applyThroughApproval(PID, { source: "markdown" })
    ).rejects.toThrow(/is not pending/);
  });
});

describe("settleRunSession — a re-sent analyze lands in its prior room", () => {
  const PRIOR_SESSION = "22222222-2222-4222-8222-222222222222";

  it("an owned prior session is reused, nothing is minted", async () => {
    h.verify.mockResolvedValue(PRIOR_SESSION);
    const r = await orchestrator().settleRunSession(
      {},
      null,
      { sessionId: PRIOR_SESSION },
      { requestedSessionIgnored: false }
    );
    expect(r).toMatchObject({
      sessionId: PRIOR_SESSION,
      sessionSource: "prior",
    });
    expect(h.resolveImportSession).not.toHaveBeenCalled();
  });

  it("a prior session the caller does NOT own is not used, and no empty room is minted", async () => {
    h.verify.mockResolvedValue(undefined);
    const r = await orchestrator().settleRunSession(
      {},
      null,
      { sessionId: PRIOR_SESSION },
      { requestedSessionIgnored: false }
    );
    expect(r).toMatchObject({ sessionId: null, sessionSource: "none" });
    expect(h.resolveImportSession).not.toHaveBeenCalled();
  });

  it("no prior at all → the full ladder (mint) runs", async () => {
    h.resolveImportSession.mockResolvedValue({
      sessionId: "33333333-3333-4333-8333-333333333333",
      sessionSource: "minted",
      requestedSessionIgnored: false,
    });
    const r = await orchestrator().settleRunSession({}, null, null, {
      requestedSessionIgnored: false,
    });
    expect(r.sessionSource).toBe("minted");
    expect(h.resolveImportSession).toHaveBeenCalledTimes(1);
  });
});

describe("analyze settles the session after the duplicate lookup (source order)", () => {
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "import-orchestrator.ts"),
    "utf8"
  );
  for (const [label, start, end] of [
    [
      "analyze",
      "  async analyze(input: ImportAnalyzeInput)",
      "  async apply(input: ImportApplyInput)",
    ],
    ["analyzeLarge", "  async analyzeLarge(", "  async applyLarge("],
  ] as const) {
    it(`${label}: phase 1 never mints, settle runs after findPriorImportGraphProposal, a dedup stages nothing`, () => {
      const body = SRC.slice(SRC.indexOf(start), SRC.indexOf(end));
      expect(body.length).toBeGreaterThan(100);
      const phase1 = body.indexOf("{ mint: false }");
      const prior = body.indexOf("await findPriorImportGraphProposal(");
      const settle = body.indexOf("await this.settleRunSession(");
      expect(phase1).toBeGreaterThan(-1);
      expect(prior).toBeGreaterThan(phase1);
      expect(settle).toBeGreaterThan(prior);
      expect(body).toContain("sessionResolution && !deduplicated");
    });
  }
});

describe("decision A — the Hub /import/apply door carries the agent", () => {
  it("passes agentUserId into the caller context the orchestrator reads", () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../routers/hub-protocol/rest/capture.ts"
      ),
      "utf8"
    );
    const route = src.slice(
      src.indexOf('app.post("/import/apply"'),
      src.indexOf('app.post("/import/store-unit"')
    );
    const ctxCall = route.slice(
      route.indexOf("createHubProtocolCallerContext("),
      route.indexOf("const orchestrator")
    );
    expect(ctxCall).toContain('c.get("agentUserId")');
  });
});
