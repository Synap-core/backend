import { describe, expect, it } from "vitest";
import { GOVERNANCE_POLICY_SENTENCES } from "@synap-core/types/proposals";
import {
  createdObject,
  updatedObject,
  reasonMark,
  reviewReadsWide,
  undoMark,
} from "./proposal-review-model";
import { initials } from "../../_lib/object/provenance-chips";
import { proposedRecord } from "./proposal-record-model";
import { proposalSubjectKind } from "./proposal-subject-kind";
import { openWidth } from "../../open/open-shell";
import { consoleWidth } from "../../_lib/object/views/object-frame";

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
  const none = {
    subjectKind: null,
    documentChanges: false,
    toolArguments: [],
    records: [],
  };
  const short = { kind: null, fields: [{ wide: false }, { wide: false }] };

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
        records: [
          short,
          { kind: null, fields: [{ wide: false }, { wide: true }] },
        ],
      })
    ).toBe(true);
  });
});

describe("reviewReadsWide — a proposal is as wide as the object it creates or changes", () => {
  /* Proposal 70fc80c4 (founder, 2026-11-03): a `document` / `create` holding
     a long markdown report read at the receiver's narrow default. Its body
     is drawn as the document (`record.body`), not as a wide field, so only
     the object's kind can say it reads wide. */
  const report = `Report 1 of 2.\n\n## The numbers\n\n${"A sentence of the report. ".repeat(300)}`;
  const docCreate = {
    targetType: "document",
    payload: {
      title: "How the work flowed",
      content: report,
      type: "markdown",
    },
    changes: [
      {
        path: "title",
        label: "Title",
        operation: "create" as const,
        after: "How the work flowed",
      },
      {
        path: "content",
        label: "Content",
        operation: "create" as const,
        after: report,
      },
      { path: "url", label: "Url", operation: "create" as const, after: null },
      {
        path: "type",
        label: "Type",
        operation: "create" as const,
        after: "markdown",
      },
    ],
  };
  const drawn = (
    p: { targetType: string; payload: unknown },
    records: ReturnType<typeof proposedRecord>[]
  ) => ({
    subjectKind: proposalSubjectKind(p, p.payload),
    documentChanges: false,
    toolArguments: [],
    records: records.filter((r) => r !== null),
  });

  it("a document create reads wide, though no field of it is wide", () => {
    const record = proposedRecord({
      changes: docCreate.changes,
      action: "create",
      kind: "document",
    });
    expect(record?.body).toBe(report);
    expect(record?.fields.some((f) => f.wide)).toBe(false);
    expect(reviewReadsWide(drawn(docCreate, [record]))).toBe(true);
  });

  it("a document edit reads wide, even a short one with no text diff drawn", () => {
    const rename = proposedRecord({
      changes: [
        {
          path: "title",
          label: "Title",
          operation: "update" as const,
          before: "Old",
          after: "New",
        },
      ],
      action: "update",
      kind: "document",
    });
    expect(
      reviewReadsWide(
        drawn({ targetType: "document", payload: { title: "New" } }, [rename])
      )
    ).toBe(true);
  });

  it("a document drawn inside a graph reads wide", () => {
    expect(
      reviewReadsWide({
        ...drawn({ targetType: "entity", payload: {} }, []),
        records: [
          { kind: "task", fields: [] },
          { kind: "document", fields: [] },
        ],
      })
    ).toBe(true);
  });

  it("a short record keeps the default width, as its page does", () => {
    const task = {
      targetType: "entity",
      payload: { profileSlug: "task", title: "Call Ana" },
    };
    const record = proposedRecord({
      changes: [
        {
          path: "title",
          label: "Title",
          operation: "create" as const,
          after: "Call Ana",
        },
        {
          path: "profileSlug",
          label: "Kind",
          operation: "create" as const,
          after: "task",
        },
        {
          path: "properties.priority",
          label: "Priority",
          operation: "create" as const,
          after: "high",
        },
      ],
      action: "create",
    });
    expect(reviewReadsWide(drawn(task, [record]))).toBe(false);
  });

  it("a prose tool argument still reads wide (the content rule holds)", () => {
    expect(
      reviewReadsWide({
        ...drawn({ targetType: "tool", payload: {} }, []),
        toolArguments: [{ wide: true }],
      })
    ).toBe(true);
  });

  it("one source: the card is wide exactly when the object's own page is", () => {
    for (const kind of ["document", "task", "skill", "automation", "session"]) {
      const card = reviewReadsWide({
        ...drawn({ targetType: kind, payload: {} }, []),
      });
      expect(openWidth({ header: { kind } }) === "lg").toBe(card);
      expect(consoleWidth({ header: { kind } }, undefined) === "wide").toBe(
        card
      );
    }
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

describe("updatedObject — the existing object an update changes, openable", () => {
  const ID = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
  const base = {
    action: "update",
    targetType: "document",
    targetId: ID,
    title: " Plan ",
    graph: false,
  };

  it("names the document by the proposal's own target", () => {
    expect(updatedObject(base)).toEqual({
      kind: "document",
      id: ID,
      title: "Plan",
    });
  });

  it("opens each kind under the word /open hosts it by (a session is not a focus_session there)", () => {
    expect(updatedObject({ ...base, targetType: "entity" })?.kind).toBe(
      "entity"
    );
    expect(updatedObject({ ...base, targetType: "playbook" })?.kind).toBe(
      "playbook"
    );
    expect(updatedObject({ ...base, targetType: "skill" })?.kind).toBe("skill");
    expect(updatedObject({ ...base, targetType: "focus_session" })?.kind).toBe(
      "session"
    );
  });

  it("has no status: the reviewer opens the object BEFORE deciding", () => {
    // Unlike createdObject, there is no status input to refuse on at all.
    expect(Object.keys(base)).not.toContain("status");
    expect(updatedObject(base)).not.toBeNull();
  });

  it("names nothing for a create, a delete, a graph or a kind /open does not host", () => {
    expect(updatedObject({ ...base, action: "create" })).toBeNull();
    expect(updatedObject({ ...base, action: "delete" })).toBeNull();
    expect(updatedObject({ ...base, graph: true })).toBeNull();
    expect(updatedObject({ ...base, targetType: "workspace" })).toBeNull();
    expect(updatedObject({ ...base, targetType: null })).toBeNull();
    expect(updatedObject({ ...base, targetType: "constructor" })).toBeNull();
  });

  it("names nothing without a real id, and keeps a missing title as null", () => {
    expect(updatedObject({ ...base, targetId: "not-an-id" })).toBeNull();
    expect(updatedObject({ ...base, targetId: null })).toBeNull();
    expect(updatedObject({ ...base, title: "   " })?.title).toBeNull();
    expect(updatedObject({ ...base, title: null })?.title).toBeNull();
  });
});
