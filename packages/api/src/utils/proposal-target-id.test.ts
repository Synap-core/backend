/**
 * One id for a document create: the proposal's `targetId` is the id the
 * approval writes the document under, so the review page can open it.
 */
import { describe, expect, it } from "vitest";
import { resolveProposalTargetId } from "./proposal-target-id.js";

const DOC = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("resolveProposalTargetId", () => {
  it("a document create files data.id, even beside a stray documentId", () => {
    expect(resolveProposalTargetId("document", "create", { id: DOC })).toBe(
      DOC
    );
    expect(
      resolveProposalTargetId("document", "create", {
        id: DOC,
        documentId: OTHER,
        entityId: OTHER,
      })
    ).toBe(DOC);
  });

  it("never invents a random id for a document create that carries one", () => {
    const a = resolveProposalTargetId("documents", "create", { id: DOC });
    const b = resolveProposalTargetId("documents", "create", { id: DOC });
    expect(a).toBe(DOC);
    expect(b).toBe(DOC);
  });

  it("keeps the other target types' order", () => {
    // A document edit names the document in documentId.
    expect(
      resolveProposalTargetId("document", "update", {
        documentId: DOC,
        id: OTHER,
      })
    ).toBe(DOC);
    // An entity write names its record in id, not the body attached to it.
    expect(
      resolveProposalTargetId("entity", "create", {
        id: DOC,
        documentId: OTHER,
      })
    ).toBe(DOC);
    expect(resolveProposalTargetId("workspace", "update", { id: DOC })).toBe(
      DOC
    );
  });

  it("falls back to a fresh id only when nothing names a target", () => {
    const a = resolveProposalTargetId("document", "create", {});
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(resolveProposalTargetId("document", "create", {}));
  });
});
