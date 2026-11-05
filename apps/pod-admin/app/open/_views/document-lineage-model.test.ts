import { describe, it, expect } from "vitest";
import { formatDate } from "../../../lib/format";
import { documentLineage } from "./document-lineage-model";

const SOURCE = "9b2f6c1e-1111-4111-8111-111111111111";
const EDIT_A = "9b2f6c1e-2222-4222-8222-222222222222";
const EDIT_B = "9b2f6c1e-3333-4333-8333-333333333333";
const DAY = "2026-11-02T10:00:00.000Z";

const edit = (id: string, title: string) => ({
  id,
  status: "pending",
  proposalType: "update",
  targetType: "document",
  targetName: title,
});

describe("documentLineage", () => {
  it("names who approved the creating proposal, and when", () => {
    const out = documentLineage(SOURCE, [
      {
        id: SOURCE,
        status: "approved",
        approverName: "Antoine",
        reviewedAt: DAY,
      },
    ]);
    expect(out.createdFrom).toEqual({
      href: `/proposal/${SOURCE}`,
      line: `Created from a proposal · approved by Antoine, ${formatDate(DAY)}`,
    });
    expect(out.waiting).toEqual([]);
    expect(out.waitingLabel).toBeNull();
  });

  it("says an auto-applied creation was approved automatically", () => {
    const out = documentLineage(SOURCE, [
      { id: SOURCE, status: "auto_approved", reviewedAt: DAY },
    ]);
    expect(out.createdFrom?.line).toBe(
      `Created from a proposal · approved automatically, ${formatDate(DAY)}`
    );
  });

  it("still links a creating proposal the viewer cannot read, without a name", () => {
    expect(documentLineage(SOURCE, []).createdFrom).toEqual({
      href: `/proposal/${SOURCE}`,
      line: "Created from a proposal",
    });
  });

  it("has no creation line for a document made directly", () => {
    expect(documentLineage(null, []).createdFrom).toBeNull();
  });

  it("counts pending changes, each a door to its proposal", () => {
    const out = documentLineage(SOURCE, [
      edit(EDIT_A, "CRM and Unipile"),
      { id: SOURCE, status: "approved", approverName: "Antoine" },
      edit(EDIT_B, "CRM and Unipile"),
      { id: "decided", status: "rejected" },
    ]);
    expect(out.waitingLabel).toBe("2 changes waiting");
    expect(out.waiting.map((w) => w.href)).toEqual([
      `/proposal/${EDIT_A}`,
      `/proposal/${EDIT_B}`,
    ]);
    // The review page's own heading, never a raw type token.
    for (const w of out.waiting) {
      expect(w.label).not.toMatch(/^update$/);
      expect(w.label.length).toBeGreaterThan(0);
    }
    expect(documentLineage(null, [edit(EDIT_A, "X")]).waitingLabel).toBe(
      "1 change waiting"
    );
  });
});
