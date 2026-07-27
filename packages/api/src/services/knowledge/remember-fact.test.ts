import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  priorFactRows: [] as Array<{ id: string; sourceEntityId: string | null }>,
  savedFactId: "fact-new",
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

vi.mock("@synap/ai-embeddings", () => ({
  generateEmbedding: vi.fn(() => Promise.resolve(new Array(1536).fill(0))),
}));

vi.mock("@synap/database", () => {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(state.priorFactRows)),
  };
  return {
    db: { select: vi.fn(() => selectChain) },
    knowledgeFacts: {
      id: "id",
      userId: "user_id",
      fact: "fact",
      sourceEntityId: "source_entity_id",
      createdAt: "created_at",
    },
    knowledgeRepository: {
      saveFact: vi.fn(() => Promise.resolve({ id: state.savedFactId })),
    },
    and: vi.fn(),
    eq: vi.fn(),
    desc: vi.fn(),
    drizzleSql: vi.fn((strings: TemplateStringsArray) => ({
      sql: strings.join("?"),
    })),
  };
});

import { rememberFact } from "./remember-fact.js";
import { knowledgeRepository } from "@synap/database";

function makeCaller(createResult: {
  status: string;
  id?: string | null;
  proposalId?: string | null;
}) {
  const createEntity = vi.fn(() => Promise.resolve(createResult));
  return { caller: { entities: { createEntity } }, createEntity };
}

beforeEach(() => {
  state.priorFactRows = [];
  state.savedFactId = "fact-new";
  vi.clearAllMocks();
});

describe("rememberFact — ack integrity", () => {
  it("applied: a fresh fact goes through the governed write (ackState=applied)", async () => {
    const { caller, createEntity } = makeCaller({
      status: "created",
      id: "e2",
    });
    const r = await rememberFact({ caller, userId: "u1", fact: "likes async" });
    expect(r.ackState).toBe("applied");
    expect(r.entityId).toBe("e2");
    expect(createEntity).toHaveBeenCalledTimes(1);
    expect(r.recallIndex.factId).toBe("fact-new");
  });

  it("proposed: a governed queue reports ackState=proposed", async () => {
    const { caller } = makeCaller({ status: "proposed", proposalId: "p1" });
    const r = await rememberFact({
      caller,
      userId: "u1",
      fact: "prefers dark mode",
    });
    expect(r.ackState).toBe("proposed");
    expect(r.status).toBe("proposed");
  });

  it("duplicate-ignored: a retry of the same fact returns the prior, no re-write", async () => {
    state.priorFactRows = [{ id: "fact-prior", sourceEntityId: "e-prior" }];
    const { caller, createEntity } = makeCaller({
      status: "created",
      id: "e2",
    });
    const r = await rememberFact({ caller, userId: "u1", fact: "likes async" });
    expect(r.ackState).toBe("duplicate-ignored");
    expect(r.entityId).toBe("e-prior");
    expect(r.recallIndex.factId).toBe("fact-prior");
    // No second governed write, no second recall row.
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("user-stated retry of a MATERIALIZED fact is deduped (scenario B — the common double-write)", async () => {
    // A prior user-stated fact auto-approved → its recall row is sourceEntityId-linked.
    // user_observation carries no identity signal, so entity-layer dedup can't catch
    // this; the window guard MUST. A retry returns the prior, no second entity.
    state.priorFactRows = [{ id: "fact-prior", sourceEntityId: "e-prior" }];
    const { caller, createEntity } = makeCaller({
      status: "created",
      id: "e2",
    });
    const r = await rememberFact({
      caller,
      userId: "u1",
      fact: "prefers dark mode",
      userStated: true,
    });
    expect(r.ackState).toBe("duplicate-ignored");
    expect(r.entityId).toBe("e-prior");
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("user-stated fact ESCALATES a still-pending AI-inferred row (scenario A — null prior does NOT suppress)", async () => {
    // A prior AI-INFERRED proposal of the same text has NO materialized entity yet
    // (sourceEntityId null). A user directly stating it must auto-approve — the null
    // prior must NOT be treated as a duplicate, or the escalation would be lost.
    state.priorFactRows = [{ id: "fact-pending", sourceEntityId: null }];
    const { caller, createEntity } = makeCaller({
      status: "created",
      id: "e-new",
    });
    const r = await rememberFact({
      caller,
      userId: "u1",
      fact: "prefers dark mode",
      userStated: true,
    });
    expect(r.ackState).toBe("applied");
    expect(r.entityId).toBe("e-new");
    // The auto-approve governed write DID run.
    expect(createEntity).toHaveBeenCalledTimes(1);
  });

  it("AI-inferred retry dedupes even against a still-pending prior (no second proposal)", async () => {
    // Two identical inferences in the window: the second must not queue a SECOND
    // proposal, even though the first has not materialized (sourceEntityId null).
    state.priorFactRows = [{ id: "fact-pending", sourceEntityId: null }];
    const { caller, createEntity } = makeCaller({
      status: "proposed",
      proposalId: "p1",
    });
    const r = await rememberFact({
      caller,
      userId: "u1",
      fact: "prefers dark mode",
    });
    expect(r.ackState).toBe("duplicate-ignored");
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("race backstop (0216): a concurrent 23505 on the recall-index insert is recovered, not thrown", async () => {
    // Step-0 peek sees nothing — this IS the race (both callers peeked before
    // either committed). The recall-index insert then loses the DB-level
    // unique index to a concurrent winner.
    state.priorFactRows = [];
    const dup = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    vi.mocked(knowledgeRepository.saveFact).mockImplementationOnce(() => {
      // Simulate the concurrent winner's row already committed by the time
      // this call's post-conflict lookup runs.
      state.priorFactRows = [{ id: "fact-winner", sourceEntityId: "e-winner" }];
      return Promise.reject(dup);
    });
    const { caller, createEntity } = makeCaller({
      status: "created",
      id: "e2",
    });
    const r = await rememberFact({ caller, userId: "u1", fact: "likes async" });
    // This call's OWN governed write already landed — it is not a duplicate
    // of anything, so it still reports success for ITS entity.
    expect(createEntity).toHaveBeenCalledTimes(1);
    expect(r.ackState).toBe("applied");
    expect(r.entityId).toBe("e2");
    // Only the recall-index row is deduped onto the winner — no second
    // knowledge_facts row for the same (user, fact, bucket).
    expect(r.recallIndex.factId).toBe("fact-winner");
  });
});
