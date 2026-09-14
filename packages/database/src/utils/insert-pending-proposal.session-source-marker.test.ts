/**
 * APPROVE-TIME MARKER (A1): a pending row filed under a DERIVED session must
 * persist `data.sessionSource = "derived"`, because `apply-approval` and the
 * materializer re-run the project ladder from the stored `sessionId` when the
 * row is approved. The marker must not enter the dedup hash.
 *
 * Driven through the real `insertPendingProposal` with a capturing executor; the
 * session row is project-scoped so the derived/explicit cases also discriminate
 * on `projectId`. Human-authored rows (no agentUserId) skip the dedup peek.
 */
import { describe, it, expect } from "vitest";
import {
  insertPendingProposal,
  computeProposalDedupHash,
  storedSessionSource,
} from "./insert-pending-proposal.js";
import { runWithDerivedSession } from "./request-write-context.js";

const SESSION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PROJ_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function capturingExecutor() {
  const inserted: Array<Record<string, unknown>> = [];
  const executor = {
    query: {
      focusSessions: { findFirst: async () => ({ projectId: PROJ_A }) },
      channels: { findFirst: async () => undefined },
      relations: { findMany: async () => [] },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ id: "p1", ...v }] };
      },
    }),
  };
  return { executor, inserted };
}

const BASE = {
  workspaceId: null,
  targetType: "entity",
  targetId: "t1",
  proposalType: "create",
  data: { title: "x" },
  createdBy: "user-1",
  sessionId: SESSION,
};

describe("storedSessionSource — the approve-time reader of the marker", () => {
  it("reads back exactly what insertPendingProposal stored for a derived session", async () => {
    const { executor, inserted } = capturingExecutor();
    await insertPendingProposal(
      { ...BASE, sessionSource: "derived" },
      executor as never
    );
    expect(storedSessionSource(inserted[0].data)).toBe("derived");
  });

  it("an explicit row, a foreign value, or no data reads as undefined (explicit)", async () => {
    const { executor, inserted } = capturingExecutor();
    await insertPendingProposal(
      { ...BASE, sessionSource: "explicit" },
      executor as never
    );
    expect(storedSessionSource(inserted[0].data)).toBeUndefined();
    expect(storedSessionSource({ sessionSource: "explicit" })).toBeUndefined();
    expect(storedSessionSource(null)).toBeUndefined();
    expect(storedSessionSource(undefined)).toBeUndefined();
  });
});

describe("insertPendingProposal — persisted sessionSource marker", () => {
  it("a DERIVED session stores the marker and no project", async () => {
    const { executor, inserted } = capturingExecutor();
    await insertPendingProposal(
      { ...BASE, sessionSource: "derived" },
      executor as never
    );
    expect(inserted[0].data).toEqual({ title: "x", sessionSource: "derived" });
    expect(inserted[0].sessionId).toBe(SESSION);
    expect(inserted[0].projectId).toBeUndefined();
  });

  it("no source, but the session IS the request's guessed session → marker + no project", async () => {
    const { executor, inserted } = capturingExecutor();
    await runWithDerivedSession(SESSION, () =>
      insertPendingProposal({ ...BASE }, executor as never)
    );
    expect(inserted[0].data).toEqual({ title: "x", sessionSource: "derived" });
    expect(inserted[0].projectId).toBeUndefined();
  });

  it("a DIFFERENT session inside the guessed-session scope → no marker, places", async () => {
    const { executor, inserted } = capturingExecutor();
    await runWithDerivedSession("dddddddd-dddd-dddd-dddd-dddddddddddd", () =>
      insertPendingProposal({ ...BASE }, executor as never)
    );
    expect(inserted[0].data).toEqual({ title: "x" });
    expect(inserted[0].projectId).toBe(PROJ_A);
  });

  it("an EXPLICIT session stores no marker and places the session project", async () => {
    const { executor, inserted } = capturingExecutor();
    await insertPendingProposal(
      { ...BASE, sessionSource: "explicit" },
      executor as never
    );
    expect(inserted[0].data).toEqual({ title: "x" });
    expect(inserted[0].projectId).toBe(PROJ_A);
  });

  it("the marker never splits the dedup hash — an agent row stores the hash of the CALLER's data", async () => {
    const { executor, inserted } = capturingExecutor();
    // The agent-row dedup peek: no existing pending duplicate.
    (executor as Record<string, unknown>).select = () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    });
    await insertPendingProposal(
      { ...BASE, agentUserId: "agent-1", sessionSource: "derived" },
      executor as never
    );
    expect(inserted[0].data).toEqual({ title: "x", sessionSource: "derived" });
    expect(inserted[0].dedupHash).toBe(
      computeProposalDedupHash({ ...BASE, data: { title: "x" } })
    );
  });
});
