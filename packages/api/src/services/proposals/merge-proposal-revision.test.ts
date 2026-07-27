import { describe, it, expect } from "vitest";
import { computeRevisedEnvelope } from "./proposals-service.js";

/**
 * Pure-shape guard for the shared revise core (`mergeProposalRevision` →
 * `computeRevisedEnvelope`), the ONE door tRPC `revise`, hub `updateProposal`,
 * and MCP `reviseProposal` route through.
 *
 * Headline bug (hub door): the IS `update_proposal` tool sends FLAT inner entity
 * fields. The old hub door merged them at the envelope TOP LEVEL, so for a
 * nested-reader envelope (`{ ..., data: INNER }`) the edits landed as junk
 * top-level keys, `proposal.data.data` (the slot the approve executors read) was
 * left untouched, and approve materialized the ORIGINAL AI draft. Silent loss.
 *
 * These assertions mirror the real executor read (`approve-executors.ts`:
 * `proposal.data.data.*`) and the real merge without a DB.
 */

/** What the entity create/update executors read: the NESTED inner payload. */
function executorReadsInner(storedData: Record<string, unknown>) {
  return (storedData.data ?? {}) as Record<string, unknown>;
}

const originalInner = {
  profileSlug: "research",
  title: "AI draft title",
  properties: { status: "todo", priority: "low" },
};

const nestedEnvelope = {
  requestId: "req-abc",
  source: "agent" as const,
  targetType: "entity",
  changeType: "create",
  data: originalInner, // the nested inner the executor reads
  reasoning: "why",
};

describe("computeRevisedEnvelope — hub door (inner patch)", () => {
  it("lands a FLAT inner entity edit in the nested slot the executor reads", () => {
    // The IS sends flat inner fields (matching the original entity structure).
    const { merged } = computeRevisedEnvelope({
      envelope: { ...nestedEnvelope },
      patch: {
        kind: "inner",
        fields: {
          profileSlug: "research",
          title: "Agent-corrected title",
          properties: { status: "in_progress", priority: "high" },
        },
      },
      actorId: "agent-1",
    });

    const readByExecutor = executorReadsInner(merged);
    expect(readByExecutor.title).toBe("Agent-corrected title");
    expect(readByExecutor.properties).toEqual({
      status: "in_progress",
      priority: "high",
    });
    // NOT leaked as junk top-level keys (the old bug).
    expect(merged.title).toBeUndefined();
    // Identity re-pinned.
    expect(merged.targetType).toBe("entity");
    expect(merged.changeType).toBe("create");
    expect(merged.requestId).toBe("req-abc");
  });

  it("shallow-merges a partial inner patch (keeps untouched inner keys)", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: { ...nestedEnvelope },
      patch: { kind: "inner", fields: { title: "Only title changed" } },
    });
    const inner = executorReadsInner(merged);
    expect(inner.title).toBe("Only title changed");
    expect(inner.profileSlug).toBe("research"); // preserved
    expect(inner.properties).toEqual({ status: "todo", priority: "low" });
  });

  it("appends a revisionHistory entry recording before/after + actor", () => {
    const { revision } = computeRevisedEnvelope({
      envelope: { ...nestedEnvelope },
      patch: { kind: "inner", fields: { title: "Agent-corrected title" } },
      actorId: "agent-1",
    });
    expect(revision.by).toBe("agent-1");
    expect(revision.patch).toEqual({ title: "Agent-corrected title" });
    expect(revision.before).toEqual({ title: "AI draft title" });
    expect(typeof revision.at).toBe("string");
  });
});

describe("computeRevisedEnvelope — tRPC door (envelope patch)", () => {
  it("is byte-identical to the historic top-level merge (frontend sends { data: inner })", () => {
    const editedInner = {
      ...originalInner,
      title: "Reviewer-corrected title",
      properties: { status: "in_progress", priority: "high" },
    };
    const { merged } = computeRevisedEnvelope({
      envelope: { ...nestedEnvelope },
      patch: { kind: "envelope", fields: { data: editedInner } },
      actorId: "user-1",
    });

    // The frontend pre-wraps as { data: inner } → lands in the nested slot.
    const readByExecutor = executorReadsInner(merged);
    expect(readByExecutor.title).toBe("Reviewer-corrected title");
    expect(readByExecutor.properties).toEqual({
      status: "in_progress",
      priority: "high",
    });
    expect(merged.targetType).toBe("entity");
    expect(merged.changeType).toBe("create");
    expect(merged.requestId).toBe("req-abc");
  });
});

describe("computeRevisedEnvelope — flat envelope (document/composite)", () => {
  it("merges an inner patch at the top level when there is no nested `data`", () => {
    const flatEnvelope = {
      requestId: "req-flat",
      source: "agent" as const,
      targetType: "entity",
      changeType: "create",
      // Composite: operations live at the envelope top level (no inner `data`).
      operations: [{ op: "create_entity", profileSlug: "task", title: "old" }],
    };
    const { merged } = computeRevisedEnvelope({
      envelope: { ...flatEnvelope },
      patch: {
        kind: "inner",
        fields: {
          operations: [
            { op: "create_entity", profileSlug: "task", title: "new" },
          ],
        },
      },
    });
    expect((merged.operations as Array<Record<string, unknown>>)[0].title).toBe(
      "new"
    );
    // No spurious nested slot created.
    expect(merged.data).toBeUndefined();
  });
});

describe("computeRevisedEnvelope — MCP door (summary/reasoning only)", () => {
  it("stores summary as `_summary` and reasoning at the top level, records history", () => {
    const { merged, revision } = computeRevisedEnvelope({
      envelope: { ...nestedEnvelope },
      summary: "Reviewer summary",
      reasoning: "Reviewer reasoning",
      actorId: "user-1",
    });
    expect(merged._summary).toBe("Reviewer summary");
    expect(merged.reasoning).toBe("Reviewer reasoning");
    // Inner untouched.
    expect(executorReadsInner(merged).title).toBe("AI draft title");
    expect(revision.patch).toEqual({
      _summary: "Reviewer summary",
      reasoning: "Reviewer reasoning",
    });
    expect(revision.before).toEqual({
      _summary: undefined,
      reasoning: "why",
    });
  });
});
