/**
 * An approved `create` whose record ALREADY EXISTS (the entity create door's
 * weak same-name gate) must tell the PERSON so, and name the existing record.
 *
 * Live 2026-10-20 (proposal c5dede63): a pending decision create sat for
 * weeks; meanwhile the founder created the same decision directly. On approve
 * the row became APPROVAL_FAILED with the AGENT's instruction as its reason —
 * "A decision with this name already exists: … Reuse an existing id (enrich /
 * attach facet), or pass forceCreate: true …". `forceCreate` is advice for an
 * agent; a person cannot act on it and it hides the one thing they need: the
 * record they already have.
 *
 * Driven by the REAL producer (`buildWeakEntityDedupMessage` +
 * `buildWeakDedupCause` from `@synap/database`, thrown exactly as
 * `routers/entities/create.ts` throws it), so a change to the producer's shape
 * fails here instead of silently falling back to the agent text.
 */

import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  buildWeakDedupCause,
  buildWeakEntityDedupMessage,
} from "@synap/database";
import {
  classifyThrownFailure,
  failureRecord,
  safeFailureSentence,
} from "./failure-classification.js";

const EXISTING = {
  id: "b0588fc6-0000-4000-8000-000000000001",
  title: "Architech targets trust-light segments first",
  type: "decision",
};

function weakDedupError(candidates = [EXISTING]) {
  return new TRPCError({
    code: "CONFLICT",
    message: buildWeakEntityDedupMessage(candidates, "decision"),
    cause: buildWeakDedupCause(candidates),
  });
}

describe("approval of a create whose record already exists", () => {
  it("the person reads that it already exists — never the agent's forceCreate advice", () => {
    const err = weakDedupError();
    const sentence = safeFailureSentence(err, classifyThrownFailure(err));
    expect(sentence).toMatch(/already exists/);
    expect(sentence).toContain(`"${EXISTING.title}"`);
    expect(sentence).toMatch(/existing decision/);
    expect(sentence).not.toMatch(/forceCreate/);
    expect(sentence).not.toMatch(/enrich|attach facet/);
    // No raw id in a sentence a person reads; the id rides as a door (below).
    expect(sentence).not.toContain(EXISTING.id);
  });

  it("the existing record rides on the failure as a door the UI can open", () => {
    const meta = classifyThrownFailure(weakDedupError());
    expect(meta.errorClass).toBe("conflict");
    expect(meta.existing).toEqual([
      { id: EXISTING.id, title: EXISTING.title, kind: "decision" },
    ]);
    expect(failureRecord(meta)).toMatchObject({
      existing: [{ id: EXISTING.id, kind: "decision" }],
    });
  });

  it("the agent keeps the gate's full message in the agent-only detail", () => {
    const meta = classifyThrownFailure(weakDedupError());
    expect(meta.detail).toMatch(/already exists/);
  });

  it("several same-name records: plural, still no advice", () => {
    const err = weakDedupError([
      EXISTING,
      { ...EXISTING, id: "b0588fc6-0000-4000-8000-000000000002" },
    ]);
    const sentence = safeFailureSentence(err, classifyThrownFailure(err));
    expect(sentence).toMatch(/existing decisions/);
    expect(sentence).not.toMatch(/forceCreate/);
  });

  it("CONTROL — any other CONFLICT keeps its own message", () => {
    const err = new TRPCError({ code: "CONFLICT", message: "Slug taken." });
    const meta = classifyThrownFailure(err);
    expect(safeFailureSentence(err, meta)).toBe("Slug taken.");
    expect(meta.existing).toBeUndefined();
  });
});
