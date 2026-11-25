import { describe, expect, it, vi } from "vitest";

/**
 * The re-grade of a held check gate REPLACES its hold in one transaction: the
 * un-pause and the new pause run on the same transaction, never on the bare
 * database, so a failure between them can never leave the session active at a
 * gate that did not pass. (The pglite suite, judge-unavailable-gate, proves
 * the behaviour end to end; its harness runs transactions inline, so this
 * file pins where the two writes go.)
 */

const h = vi.hoisted(() => {
  // The real modules load beside the stubs; none connects in this file.
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    db: null as unknown,
    tx: { name: "tx" },
    writes: [] as Array<{ executor: unknown; from: string; to: string }>,
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const db = {
    query: {
      focusSessions: {
        findFirst: async () => ({
          id: "s1",
          status: "paused",
          currentStage: "review",
          workspaceId: null,
          projectId: null,
          channelId: null,
          playbookId: "p1",
          subjectEntityId: null,
          metadata: { checkGate: { stageKey: "review", fromStage: "work" } },
        }),
      },
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(h.tx),
  };
  h.db = db;
  return {
    ...(await importOriginal<typeof import("@synap/database")>()),
    db,
    setSessionStatus: async (
      executor: unknown,
      input: { from: string; to: string }
    ) => {
      h.writes.push({ executor, from: input.from, to: input.to });
      return { rows: [{ id: "s1" }] };
    },
  };
});
vi.mock("../evaluations/evaluate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../evaluations/evaluate.js")>()),
  heldByCheckGate: async () => true,
  resumeCheckGateIfMet: async () => false,
}));
vi.mock("../advance-stage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../advance-stage.js")>()),
  returnToOnFailStage: async () => null,
}));
vi.mock("../../playbooks/stage-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../playbooks/stage-gate.js")>()),
  sessionGateSubject: () => ({
    // The judge still cannot run, now for another reason: a dated retry.
    checkFailing: async () => ({ failing: ["audit"], notJudged: true }),
  }),
  checkGatePause: () => ({
    hold: {
      on: "thing",
      ref: "check:review",
      until: { date: "2099-01-01T00:00:00.000Z" },
    },
    metadataPatch: {},
  }),
  pauseSessionAtGate: async (executor: unknown) => {
    h.writes.push({ executor, from: "active", to: "paused" });
    return true;
  },
}));

import { regradeAiHeldGate } from "../ai-held-gate.js";

describe("regradeAiHeldGate replaces a hold in one transaction", () => {
  it("un-pauses and pauses again on the same transaction, never on the bare database", async () => {
    h.writes = [];
    const graded = await regradeAiHeldGate({
      sessionId: "s1",
      userId: "u1",
      until: { moves: "ai:available" },
    });
    expect(graded).toBe("held");
    expect(h.writes).toEqual([
      { executor: h.tx, from: "paused", to: "active" },
      { executor: h.tx, from: "active", to: "paused" },
    ]);
  });

  it("the same kind of wait still held writes nothing", async () => {
    h.writes = [];
    const graded = await regradeAiHeldGate({
      sessionId: "s1",
      userId: "u1",
      until: { date: "2026-01-01T00:00:00.000Z" },
    });
    expect(graded).toBe("held");
    expect(h.writes).toEqual([]);
  });
});
