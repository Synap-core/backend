import { describe, expect, it } from "vitest";
import { GOVERNANCE_POLICY_SENTENCES } from "@synap-core/types/proposals";
import {
  createdObject,
  reasonMark,
  reviewReadsWide,
  undoMark,
} from "./proposal-review-model";
import { initials } from "../../_lib/object/provenance-chips";

describe("reasonMark — WHY it waits, as one mark, only when it is particular", () => {
  it("names the reason, not the ladder's reach; the sentence rides behind it", () => {
    expect(reasonMark("POSSIBLE_DUPLICATE")).toEqual({
      tone: "warning",
      label: "Possible duplicate",
      sentence: GOVERNANCE_POLICY_SENTENCES.POSSIBLE_DUPLICATE,
    });
  });

  it("a floor or an ambiguous code warns", () => {
    expect(reasonMark("SCOPE_IDENTITY_CHANGE")?.tone).toBe("warning");
    expect(reasonMark("CHANNEL_PROPOSE")?.tone).toBe("warning");
  });

  it("a reason that only restates 'this waits for you' draws no mark", () => {
    expect(reasonMark("WRITES_REQUIRE_PROPOSAL")).toBeNull();
    expect(reasonMark("GOVERNANCE_RULE")).toBeNull();
    expect(reasonMark("HUMAN_GATE")).toBeNull();
  });

  it("absent, unknown and inherited names draw no mark", () => {
    expect(reasonMark("toString")).toBeNull();
    expect(reasonMark(null)).toBeNull();
  });
});

describe("undoMark — undo is the default, so only its absence is marked", () => {
  it("draws nothing for an undoable or unknown change", () => {
    expect(undoMark(true)).toBeNull();
    expect(undoMark(undefined)).toBeNull();
    expect(undoMark(null)).toBeNull();
  });

  it("marks the pod's own `revertable: false`", () => {
    expect(undoMark(false)?.label).toBe("Can't be undone");
  });
});

describe("initials", () => {
  it("first and last word, or the first two letters of one", () => {
    expect(initials("Ada King Lovelace")).toBe("AL");
    expect(initials("claude")).toBe("CL");
    expect(initials("  ")).toBe("?");
  });
});

describe("reviewReadsWide — a review that shows text reads at a document's width", () => {
  const none = { documentChanges: false, toolArguments: [], records: [] };
  const short = { fields: [{ wide: false }, { wide: false }] };

  it("short values only: the default width", () => {
    expect(reviewReadsWide(none)).toBe(false);
    expect(
      reviewReadsWide({
        ...none,
        toolArguments: [{ wide: false }],
        records: [short, short],
      })
    ).toBe(false);
  });

  it("a document's change reads wide", () => {
    expect(reviewReadsWide({ ...none, documentChanges: true })).toBe(true);
  });

  it("one wide tool argument reads wide", () => {
    expect(
      reviewReadsWide({
        ...none,
        toolArguments: [{ wide: false }, { wide: true }],
      })
    ).toBe(true);
  });

  it("one wide field in any record reads wide (a graph's skill, a note)", () => {
    expect(
      reviewReadsWide({
        ...none,
        records: [short, { fields: [{ wide: false }, { wide: true }] }],
      })
    ).toBe(true);
  });
});

describe("createdObject — what an approved create made, openable", () => {
  const ID = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
  const base = {
    status: "approved",
    action: "create",
    targetType: "document",
    targetId: ID,
    title: " Plan ",
    graph: false,
  };

  it("names the document by the proposal's own target, approved or auto-approved", () => {
    expect(createdObject(base)).toEqual({
      kind: "document",
      id: ID,
      title: "Plan",
    });
    expect(createdObject({ ...base, status: "auto_approved" })?.id).toBe(ID);
  });

  it("names nothing while pending, rejected, an edit, a graph or an unhosted kind", () => {
    expect(createdObject({ ...base, status: "pending" })).toBeNull();
    expect(createdObject({ ...base, status: "rejected" })).toBeNull();
    expect(createdObject({ ...base, action: "update" })).toBeNull();
    expect(createdObject({ ...base, graph: true })).toBeNull();
    expect(createdObject({ ...base, targetType: "workspace" })).toBeNull();
    expect(createdObject({ ...base, targetId: "not-an-id" })).toBeNull();
  });
});
