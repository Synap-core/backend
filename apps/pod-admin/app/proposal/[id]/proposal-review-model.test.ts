import { describe, expect, it } from "vitest";
import { GOVERNANCE_POLICY_SENTENCES } from "@synap-core/types/proposals";
import {
  resolveActionLabel,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import {
  aboutObject,
  madeRows,
  reasonMark,
  reviewReadsWide,
  undoMark,
} from "./proposal-review-model";
import { initials } from "../../_lib/object/provenance-chips";
import { proposalPageT } from "./copy";
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
  it("draws nothing for an undoable change", () => {
    expect(undoMark(true)).toBeNull();
  });

  it("marks an unknown revertability, as the shared rule does (D6)", () => {
    expect(undoMark(undefined)?.label).toBe("Can't be undone");
    expect(undoMark(null)?.label).toBe("Can't be undone");
  });

  it("marks the pod's own `revertable: false`", () => {
    expect(undoMark(false)?.label).toBe("Can't be undone");
  });

  it("says an unmeasured undo as unmeasured, never as the pod's own refusal", () => {
    const t = proposalPageT();
    expect(undoMark(false)?.sentence).toBe(t("undo.cannot"));
    for (const unknown of [undefined, null]) {
      expect(undoMark(unknown)?.sentence).toBe(t("undo.unknown"));
      expect(undoMark(unknown)?.sentence).not.toBe(t("undo.cannot"));
    }
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

describe("aboutObject — what the request names until it applies", () => {
  const ID = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
  const ENTITY = "8e5a7d1f-7b2c-4b9f-8a64-4f3c2d1e0f22";
  const pending = {
    status: "pending",
    proposalType: "document.update",
    targetType: "document",
    targetId: ID,
    data: {},
  };

  it("names an update's object while it waits, and after a rejection", () => {
    expect(aboutObject(pending)).toEqual({
      kind: "document",
      id: ID,
      role: null,
    });
    expect(aboutObject({ ...pending, status: "rejected" })?.id).toBe(ID);
  });

  it("opens a session under the word /open hosts it by", () => {
    expect(aboutObject({ ...pending, targetType: "focus_session" })?.kind).toBe(
      "session"
    );
  });

  it("names nothing once applied, a facet's entity and a partial apply included", () => {
    expect(aboutObject({ ...pending, status: "approved" })).toBeNull();
    expect(
      aboutObject({ ...pending, status: "partially_approved" })
    ).toBeNull();
    const facet = {
      status: "pending",
      proposalType: "facet.detach",
      targetType: "facet",
      targetId: ID,
      data: { entityId: ENTITY },
    };
    expect(aboutObject(facet)?.id).toBe(ENTITY);
    expect(aboutObject({ ...facet, status: "approved" })).toBeNull();
  });

  it("names nothing for a pending create, a graph or a non-id target", () => {
    expect(aboutObject({ ...pending, proposalType: "document.create" })).toBe(
      null
    );
    expect(aboutObject({ ...pending, targetType: "composite" })).toBeNull();
    expect(aboutObject({ ...pending, targetId: "not-an-id" })).toBeNull();
  });
});

describe("madeRows — each landed object with its mark and one act", () => {
  const AUTOMATION = "11111111-1111-4111-8111-111111111111";
  const LEAD = "22222222-2222-4222-8222-222222222222";
  const THING = "33333333-3333-4333-8333-333333333333";
  const SESSION = "44444444-4444-4444-8444-444444444444";

  it("an object that needs nothing: named by its kind, what approving did, no step", () => {
    const [row] = madeRows([
      {
        id: LEAD,
        kind: "entity",
        profileSlug: "lead",
        name: null,
        role: "created",
        next: null,
      },
    ]);
    expect(row).toEqual({
      kind: "lead",
      openKind: "entity",
      id: LEAD,
      title: resolveObjectNoun("lead"),
      done: resolveActionLabel("create", "past"),
      step: null,
    });
  });

  it("a draft automation offers Turn on through its governed door", () => {
    const [row] = madeRows([
      {
        id: AUTOMATION,
        kind: "automation",
        name: "Weekly digest",
        role: "created",
        next: { action: "turn_on", reason: "draft" },
      },
    ]);
    expect(row?.step?.act).toEqual({
      kind: "turn_on",
      objectKind: "automation",
      id: AUTOMATION,
    });
  });

  it("work owed by the person is its mark and one door to the app", () => {
    const [row] = madeRows([
      {
        id: THING,
        kind: "entity",
        name: "Acme",
        role: "updated",
        next: { action: "answer", reason: "owed_slot", sessionId: SESSION },
      },
    ]);
    expect(row?.done).toBe(resolveActionLabel("update", "past"));
    expect(row?.step?.act).toEqual({
      kind: "in_app",
      objectKind: "session",
      id: SESSION,
    });
  });

  it("what needs the person comes first; a step not read is marked, not first", () => {
    const rows = madeRows([
      { id: LEAD, kind: "entity", name: "Lead", role: "linked" },
      { id: THING, kind: "entity", name: "Acme", role: "linked", next: null },
      {
        id: AUTOMATION,
        kind: "automation",
        name: "Digest",
        role: "created",
        next: { action: "see_failure", reason: "latest_failed" },
      },
    ]);
    expect(rows.map((r) => r.id)).toEqual([AUTOMATION, LEAD, THING]);
    expect(rows[0]?.step?.pill.kind).toBe("down");
    expect(rows[1]?.step).toMatchObject({ measured: false, act: null });
    expect(rows[2]?.step).toBeNull();
  });

  it("no landed objects, no rows", () => {
    expect(madeRows(undefined)).toEqual([]);
  });
});
