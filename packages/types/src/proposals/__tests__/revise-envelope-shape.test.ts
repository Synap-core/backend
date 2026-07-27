import { describe, it, expect } from "vitest";
import { buildRequestFromProposal } from "../index.js";
import type { Proposal } from "@synap/database";

/**
 * Regression guard for the "Save & Approve" (revise) headline bug.
 *
 * The stored `proposals.data` is an ENVELOPE: `{ requestId, source, targetType,
 * changeType, data: INNER, reasoning }`. The entity create/update executors read
 * the fields the reviewer edits from the NESTED inner (`proposal.data.data.*`),
 * NOT the envelope top level. So a revise payload has to land in that nested slot.
 *
 * This bug shipped in 3c928155: the frontend sent the already-unwrapped inner
 * (`request.data`) straight to revise, which merged it at the envelope top level,
 * leaving `merged.data` (the nested inner the executor reads) unchanged — edits
 * silently dropped, original AI draft materialized on approve.
 *
 * These are pure shape assertions (no DB) mirroring the real merge
 * (`proposals.ts` revise) and the real executor read (`approve-executors.ts`).
 */

/** Minimal Proposal row carrying a nested envelope in its `data` column. */
function makeRow(data: unknown): Proposal {
  return {
    id: "prop-1111-2222-3333-4444-555555555555",
    workspaceId: "ws-1",
    targetType: "entity",
    targetId: "",
    proposalType: "create",
    data,
    status: "pending",
    createdBy: "user-1",
    agentUserId: "agent-1",
  } as unknown as Proposal;
}

/**
 * The exact merge `revise` performs (proposals.ts): spread the corrected payload
 * over the existing envelope, re-pinning the routing/identity fields.
 */
function reviseMerge(
  existing: Record<string, unknown>,
  input: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...existing,
    ...input,
    targetType: existing.targetType,
    changeType: existing.changeType,
    requestId: existing.requestId,
  };
}

/** What the entity/create executor reads: the NESTED inner payload. */
function executorReadsInner(storedData: Record<string, unknown>) {
  return (storedData.data ?? {}) as Record<string, unknown>;
}

describe("revise envelope shape (Save & Approve)", () => {
  const originalInner = {
    profileSlug: "research",
    title: "AI draft title",
    properties: { status: "todo", priority: "low" },
  };

  const envelope = {
    requestId: "req-abc",
    source: "agent" as const,
    targetType: "entity",
    changeType: "create",
    data: originalInner, // <-- the nested inner the executor reads
    reasoning: "why",
  };

  it("buildRequestFromProposal unwraps to the nested inner (the frontend's request.data)", () => {
    const request = buildRequestFromProposal(makeRow(envelope));
    // request.data IS the inner — this is the value the frontend hands to revise.
    expect(request.data).toEqual(originalInner);
  });

  it("wrapping the edited inner as { data } lands the edit in the nested slot the executor reads", () => {
    const request = buildRequestFromProposal(makeRow(envelope));
    const editedInner = {
      ...(request.data as Record<string, unknown>),
      title: "Reviewer-corrected title",
      properties: { status: "in_progress", priority: "high" },
    };

    // The FIX: the frontend wraps the edited inner as `{ data: editedInner }`.
    const merged = reviseMerge(envelope as unknown as Record<string, unknown>, {
      data: editedInner,
    });

    // The executor reads the nested inner — it now carries the reviewer's edits.
    const readByExecutor = executorReadsInner(merged);
    expect(readByExecutor.title).toBe("Reviewer-corrected title");
    expect(readByExecutor.properties).toEqual({
      status: "in_progress",
      priority: "high",
    });
    // Routing/identity stay pinned.
    expect(merged.targetType).toBe("entity");
    expect(merged.changeType).toBe("create");
    expect(merged.requestId).toBe("req-abc");
  });

  it("REGRESSION: sending the unwrapped inner directly leaves the executor reading the ORIGINAL draft", () => {
    const request = buildRequestFromProposal(makeRow(envelope));
    const editedInner = {
      ...(request.data as Record<string, unknown>),
      title: "Reviewer-corrected title",
    };

    // The BUG: send the inner straight through (no `{ data }` wrap).
    const merged = reviseMerge(
      envelope as unknown as Record<string, unknown>,
      editedInner
    );

    // The edited fields land as junk top-level keys; the nested slot is untouched,
    // so the executor still reads the ORIGINAL AI title. This is the silent drop.
    const readByExecutor = executorReadsInner(merged);
    expect(readByExecutor.title).toBe("AI draft title");
    expect(merged.title).toBe("Reviewer-corrected title"); // junk top-level key
  });
});
