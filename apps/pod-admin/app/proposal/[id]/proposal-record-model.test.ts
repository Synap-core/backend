/**
 * The record a proposal creates or changes, from the pod's diff
 * (`review.changes`) — the rules the card draws. Rows that rule out a wrong
 * rule: a uuid-valued `…Id` key (a hand list of "resolvedWorkspaceId" would
 * miss `ownerId`); an empty create value beside a recorded-empty update
 * (dropping every empty would hide "cleared"); a defined label that is not the
 * key humanized ("Job title" for `role`).
 */
import { describe, expect, it } from "vitest";
import {
  graphRecords,
  isMachineKey,
  proposedEntityMedia,
  proposedRecord,
  RECORD_FIELDS_SHOWN,
  recordValue,
} from "./proposal-record-model";

const UUID = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";

describe("proposedRecord — a create", () => {
  const changes = [
    {
      path: "title",
      label: "Title",
      operation: "create" as const,
      after: "Ada",
    },
    {
      path: "profileSlug",
      label: "ProfileSlug",
      operation: "create" as const,
      after: "person",
    },
    {
      path: "properties.role",
      label: "Role",
      operation: "create" as const,
      after: "CTO",
    },
    {
      path: "properties.note",
      label: "Note",
      operation: "create" as const,
      after: "",
    },
    {
      path: "properties.ownerId",
      label: "OwnerId",
      operation: "create" as const,
      after: UUID,
    },
    {
      path: "resolvedWorkspaceId",
      label: "ResolvedWorkspaceId",
      operation: "create" as const,
      after: UUID,
    },
    {
      path: "documentId",
      label: "DocumentId",
      operation: "create" as const,
      after: UUID,
    },
  ];

  it("title and kind become the heading and the mark, not fields", () => {
    const r = proposedRecord({ changes, action: "create" })!;
    expect(r.title).toBe("Ada");
    expect(r.kind).toBe("person");
    expect(r.fields.map((f) => f.key)).toEqual(["properties.role"]);
  });

  it("an id key the pod resolved is a door; one it did not is left out", () => {
    const r = proposedRecord({
      changes,
      action: "create",
      objectRefs: { documentId: { id: UUID, kind: "document", name: "Brief" } },
    })!;
    const doc = r.fields.find((f) => f.key === "documentId");
    expect(doc?.after).toEqual({
      kind: "ref",
      objectKind: "document",
      id: UUID,
      name: "Brief",
    });
    expect(r.fields.some((f) => f.key === "properties.ownerId")).toBe(false);
  });

  it("a property's DEFINED label wins over its key", () => {
    const r = proposedRecord({
      changes,
      action: "create",
      definitions: [
        {
          id: "d",
          slug: "role",
          valueType: "string",
          uiHints: { displayName: "Job title" },
        },
      ],
    })!;
    expect(r.fields[0]).toMatchObject({
      label: "Job title",
      after: { kind: "text", text: "CTO" },
    });
  });
});

describe("proposedRecord — an update", () => {
  it("keeps a renamed title as a before → after field, and a cleared value", () => {
    const r = proposedRecord({
      action: "update",
      targetName: "Ada",
      changes: [
        {
          path: "title",
          label: "Title",
          operation: "update",
          before: "Ada",
          after: "Ada L.",
        },
        {
          path: "properties.role",
          label: "Role",
          operation: "update",
          before: "CTO",
          after: null,
        },
        {
          path: "properties.city",
          label: "City",
          operation: "update",
          before: null,
          after: null,
        },
      ],
    })!;
    expect(r.title).toBe("Ada");
    expect(
      r.fields.map((f) => [
        f.key,
        f.op,
        f.before?.kind ?? f.before,
        f.after?.kind ?? f.after,
      ])
    ).toEqual([
      ["title", "change", "text", "text"],
      ["properties.role", "change", "text", null],
    ]);
  });

  it("a mechanical label is said through the label door; the pod's words stay", () => {
    const r = proposedRecord({
      action: "update",
      changes: [
        {
          path: "profileSlug",
          label: "ProfileSlug",
          operation: "update",
          before: "finding",
          after: "issue",
        },
        {
          path: "metadata.allowedHosts",
          label: "External hosts (sandbox allowlist)",
          operation: "update",
          after: ["a.com"],
        },
      ],
    })!;
    expect(r.fields.map((f) => f.label)).toEqual([
      "Kind",
      "External hosts (sandbox allowlist)",
    ]);
  });
});

describe("recordValue — each value in its type's reading", () => {
  it("a url is a link, only for a web address", () => {
    expect(recordValue("url", "https://acme.io/")).toEqual({
      kind: "link",
      href: "https://acme.io/",
      text: "acme.io",
    });
    expect(recordValue("url", "javascript:alert(1)")?.kind).toBe("text");
  });

  it("a status is a status, a secret and a bare id are nothing", () => {
    expect(recordValue("status", "in_progress")?.kind).toBe("status");
    expect(recordValue("secret", "hunter2")).toBeNull();
    expect(recordValue("text", UUID)).toBeNull();
  });
});

describe("proposedRecord — a skill create: the code is read whole, first", () => {
  // > 600 characters and > 40 lines: both the old text clip and the card's
  // fold would have cut it.
  const code = Array.from(
    { length: 60 },
    (_, i) =>
      `const step${i} = await callProvider("apify_api", "GET", "/acts/${i}");`
  ).join("\n");
  const filler = [
    "description",
    "kind",
    "slug",
    "name",
    "body",
    "providerSpec",
    "parameters",
    "category",
    "executionMode",
    "timeoutSeconds",
    "intent",
  ].map((path) => ({
    path,
    label: path,
    operation: "create" as const,
    after: path === "timeoutSeconds" ? 120 : `${path} value`,
  }));
  const record = proposedRecord({
    action: "create",
    kind: "skill",
    changes: [
      ...filler,
      {
        path: "code",
        label: "Code",
        operation: "create" as const,
        after: code,
      },
      {
        path: "requiredToolNames",
        label: "RequiredToolNames",
        operation: "create" as const,
        after: ["apify_api"],
      },
    ],
  })!;

  it("keeps every character and line of the code, as code", () => {
    const field = record.fields.find((f) => f.key === "code")!;
    expect(field.after).toEqual({ kind: "code", text: code, lines: 60 });
    expect(code.length).toBeGreaterThan(600);
    expect(field.wide).toBe(true);
  });

  it("leads with the code, its instructions and its tools, ahead of the fold", () => {
    expect(record.fields.length).toBeGreaterThan(RECORD_FIELDS_SHOWN);
    expect(record.fields.slice(0, 3).map((f) => f.key)).toEqual([
      "code",
      "body",
      "requiredToolNames",
    ]);
    expect(record.fields[2]!.after).toEqual({
      kind: "tags",
      items: ["apify_api"],
    });
    // The rest keep the pod's order.
    expect(record.fields.slice(3).map((f) => f.key)).toEqual(
      filler.map((f) => f.path).filter((p) => p !== "body")
    );
  });

  it("a PROPERTY named code is an ordinary value, not the record's code", () => {
    const entity = proposedRecord({
      action: "create",
      kind: "person",
      changes: [
        {
          path: "properties.code",
          label: "Code",
          operation: "create" as const,
          after: "A-12",
        },
      ],
    })!;
    expect(entity.fields[0]!.after?.kind).toBe("text");
  });
});

describe("proposedRecord — a skill's instructions are never cut", () => {
  // An agent's rewrite of a skill's instructions: ~9,000 characters, the
  // size the old 600-character clip cut to its first lines.
  const before = "## Creative director\n\nKeep the brand voice.";
  const after = Array.from(
    { length: 300 },
    (_, i) => `- Rule ${i}: write the caption the way the brief says.`
  ).join("\n");

  it("an update draws the body's rewrite whole, as its changes, first", () => {
    const record = proposedRecord({
      action: "update",
      kind: "skill",
      targetName: "creative-director",
      changes: [
        {
          path: "description",
          label: "Description",
          operation: "update" as const,
          before: "old",
          after: "new",
        },
        {
          path: "body",
          label: "Body",
          operation: "update" as const,
          before,
          after,
        },
      ],
    })!;
    expect(record.title).toBe("creative-director");
    const field = record.fields[0]!;
    expect(field.key).toBe("body");
    expect(after.length).toBeGreaterThan(9_000);
    // Read paragraph by paragraph: what went, and every character it became.
    expect(field.after?.kind).toBe("changes");
    const lines =
      field.after?.kind === "changes" ? field.after.change.lines : [];
    const added = lines
      .flatMap((l) =>
        l.op === "add" ? [l.text] : l.op === "change" ? [l.after] : []
      )
      .join("\n");
    const removed = lines
      .flatMap((l) =>
        l.op === "del" ? [l.text] : l.op === "change" ? [l.before] : []
      )
      .join("\n");
    expect(added).toContain(after);
    expect(removed).toContain("Keep the brand voice.");
    expect(field.before).toBeUndefined();
    expect(field.wide).toBe(true);
  });

  it("with no before on record, the new body is drawn whole as written", () => {
    const record = proposedRecord({
      action: "update",
      kind: "skill",
      changes: [
        { path: "body", label: "Body", operation: "update" as const, after },
      ],
    })!;
    expect(record.fields[0]!.after).toEqual({
      kind: "code",
      text: after,
      lines: 300,
    });
  });

  it("code reads as a line diff over the whole code (never a prose diff)", () => {
    const record = proposedRecord({
      action: "update",
      kind: "skill",
      changes: [
        {
          path: "code",
          label: "Code",
          operation: "update" as const,
          before: "return 1;",
          after: "return 2;",
        },
      ],
    })!;
    expect(record.fields[0]!.before).toBeUndefined();
    expect(record.fields[0]!.after).toEqual({
      kind: "changes",
      change: { before: "return 1;", after: "return 2;", lines: [] },
      code: true,
    });
  });

  it("`instructions` is read whole too; a PROPERTY named body is not", () => {
    const record = proposedRecord({
      action: "create",
      kind: "skill",
      changes: [
        {
          path: "instructions",
          label: "Instructions",
          operation: "create" as const,
          after,
        },
        {
          path: "properties.body",
          label: "Body",
          operation: "create" as const,
          after: "Short note",
        },
      ],
    })!;
    expect(record.fields[0]!.after).toEqual({
      kind: "code",
      text: after,
      lines: 300,
    });
    expect(record.fields[1]!.after?.kind).toBe("text");
  });
});

describe("isMachineKey", () => {
  it("ids and the shared system fields; never an ordinary word ending in -id", () => {
    for (const k of [
      "id",
      "ownerId",
      "memberIds",
      "parent_id",
      "createdAt",
      "embedding",
    ]) {
      expect(isMachineKey(k), k).toBe(true);
    }
    for (const k of ["paid", "valid", "role", "squid"]) {
      expect(isMachineKey(k), k).toBe(false);
    }
  });
});

describe("graphRecords — a capture graph's new records", () => {
  it("one per create_entity op, keyed by its ref (else $opN); a linked record has none", () => {
    const records = graphRecords(
      {
        operations: [
          {
            op: "create_entity",
            ref: "e0",
            profileSlug: "person",
            title: "Ada",
            properties: { role: "CTO" },
          },
          { op: "create_entity", profileSlug: "company", title: "Acme" },
          {
            op: "create_entity",
            ref: "e2",
            existingEntityId: UUID,
            title: "Old",
          },
          {
            op: "create_relation",
            sourceRef: "e0",
            targetRef: "$op1",
            type: "works_at",
          },
        ],
      },
      () => undefined
    );
    expect(
      records.map((r) => [r.ref, r.title, r.kind, r.fields.length])
    ).toEqual([
      ["e0", "Ada", "person", 1],
      ["$op1", "Acme", "company", 0],
    ]);
  });
});

describe("proposedEntityMedia — the upload a create would make", () => {
  const doc = "44444444-4444-4444-8444-444444444444";

  it("an uploaded image waiting for approval is drawn from its stored document", () => {
    expect(
      proposedEntityMedia({
        profileSlug: "file",
        title: "Carousel 04",
        documentId: doc,
        properties: { mimeType: "image/png", fileSize: 1200 },
      })
    ).toEqual({ via: "stored", documentId: doc, mime: "image/png" });
  });

  it("a record with no image — or no record — has none", () => {
    expect(
      proposedEntityMedia({
        profileSlug: "file",
        documentId: doc,
        properties: { mimeType: "application/pdf" },
      })
    ).toBeNull();
    expect(
      proposedEntityMedia({ profileSlug: "person", title: "Ana" })
    ).toBeNull();
    expect(proposedEntityMedia(null)).toBeNull();
    expect(proposedEntityMedia("x")).toBeNull();
  });
});

describe("proposedRecord — any long text rewrite reads as the whole text, changed in place", () => {
  const before =
    "Follow up on the leads in outreach whose next action date is today.\n\nNever send.";
  const after =
    "Follow up on the leads in outreach whose next action date is today or past.\n\nNever send.";

  it("a playbook's goal (a top-level text) is diffed, not drawn as two cards", () => {
    const record = proposedRecord({
      action: "update",
      kind: "playbook",
      changes: [
        {
          path: "goalTemplate",
          label: "GoalTemplate",
          operation: "update" as const,
          before,
          after,
        },
      ],
    })!;
    const field = record.fields[0]!;
    expect(field.before).toBeUndefined();
    expect(field.after?.kind).toBe("changes");
    const change = field.after?.kind === "changes" ? field.after.change : null;
    expect(change?.before).toBe(before);
    expect(change?.after).toBe(after);
    expect(change?.lines.map((l) => l.op)).toEqual(["change", "same"]);
    expect(field.wide).toBe(true);
  });

  it("a long text property is diffed too", () => {
    const record = proposedRecord({
      action: "update",
      kind: "note",
      changes: [
        {
          path: "properties.content",
          label: "Content",
          operation: "update" as const,
          before,
          after,
        },
      ],
    })!;
    expect(record.fields[0]!.after?.kind).toBe("changes");
  });

  it("a secret is never diffed, however long", () => {
    const record = proposedRecord({
      action: "update",
      kind: "connection",
      definitions: [
        { slug: "apiKey", label: "API key", valueType: "secret" } as never,
      ],
      changes: [
        {
          path: "properties.apiKey",
          label: "API key",
          operation: "update" as const,
          before: "sk-".padEnd(120, "a"),
          after: "sk-".padEnd(120, "b"),
        },
      ],
    });
    const after = record?.fields[0]?.after;
    expect(after?.kind).not.toBe("changes");
    expect(JSON.stringify(record ?? null)).not.toContain("sk-aaaa");
  });

  it("a short text keeps its before → after reading", () => {
    const record = proposedRecord({
      action: "update",
      kind: "note",
      changes: [
        {
          path: "title",
          label: "Title",
          operation: "update" as const,
          before: "Old",
          after: "New",
        },
      ],
    })!;
    expect(record.fields[0]!.before).toMatchObject({
      kind: "text",
      text: "Old",
    });
    expect(record.fields[0]!.after).toMatchObject({
      kind: "text",
      text: "New",
    });
  });

  it("with no before on record, a long text is drawn as written (nothing to diff)", () => {
    const record = proposedRecord({
      action: "update",
      kind: "playbook",
      changes: [
        {
          path: "goalTemplate",
          label: "GoalTemplate",
          operation: "update" as const,
          after,
        },
      ],
    })!;
    expect(record.fields[0]!.after?.kind).toBe("text");
  });
});

describe("proposedRecord — a removal names what it removes", () => {
  it("a delete draws each value it removes, never 'empty'", () => {
    const record = proposedRecord({
      changes: [
        {
          path: "properties.role",
          label: "Role",
          operation: "delete",
          before: "CTO",
        },
      ],
      action: "delete",
      targetName: "Ada",
      kind: "person",
    });
    expect(record?.op).toBe("delete");
    expect(record?.fields).toEqual([
      expect.objectContaining({
        key: "properties.role",
        op: "remove",
        before: { kind: "text", text: "CTO", long: false },
        after: undefined,
      }),
    ]);
  });

  it("a removal with nothing readable is not drawn", () => {
    const record = proposedRecord({
      changes: [
        { path: "properties.role", label: "Role", operation: "delete" },
        {
          path: "properties.city",
          label: "City",
          operation: "delete",
          before: "Lyon",
        },
      ],
      action: "delete",
      targetName: "Ada",
      kind: "person",
    });
    expect(record?.fields.map((f) => f.key)).toEqual(["properties.city"]);
  });
});

describe("proposedRecord — a link reads as what it joins", () => {
  // Live shape (proposal f15b68ae, 2026-10-28): a session's blocked_by link.
  const FROM = "dfc6c1be-0cb4-423a-951a-7a543b92756f";
  const TO = "a74e5430-6bc0-40b0-bc33-be683967f541";
  const row = (path: string, before: string) => ({
    path,
    label: path,
    operation: "delete" as const,
    before,
  });
  const changes = [
    row("title", "Session blocked by session"),
    row("toId", TO),
    row("fromId", FROM),
    row("toType", "session"),
    row("fromType", "session"),
    row("linkType", "blocked_by"),
    row("sourceLabel", "Markdown → pod cleanup"),
    row("targetLabel", "Resolve what needs you: fix round and merge"),
  ];
  const objectRefs = {
    fromId: { id: FROM, kind: "session", name: "Markdown → pod cleanup" },
    toId: {
      id: TO,
      kind: "session",
      name: "Resolve what needs you: fix round and merge",
    },
  };

  it("a delete names both ends as doors and the relation between them", () => {
    const record = proposedRecord({
      changes,
      action: "delete",
      targetName: "Session blocked by session",
      kind: "link",
      objectRefs,
    });
    expect(record?.title).toBe(
      "Markdown → pod cleanup blocked by Resolve what needs you: fix round and merge"
    );
    expect(record?.fields.map((f) => [f.label, f.op, f.before])).toEqual([
      [
        "From",
        "remove",
        {
          kind: "ref",
          objectKind: "session",
          id: FROM,
          name: "Markdown → pod cleanup",
        },
      ],
      ["Relation", "remove", { kind: "text", text: "Blocked by", long: false }],
      [
        "To",
        "remove",
        {
          kind: "ref",
          objectKind: "session",
          id: TO,
          name: "Resolve what needs you: fix round and merge",
        },
      ],
    ]);
  });

  it("unresolved ends fall back to the names the pod wrote beside them", () => {
    const record = proposedRecord({
      changes,
      action: "delete",
      targetName: "Session blocked by session",
      kind: "link",
    });
    expect(record?.fields.map((f) => f.before)).toEqual([
      { kind: "text", text: "Markdown → pod cleanup", long: false },
      { kind: "text", text: "Blocked by", long: false },
      {
        kind: "text",
        text: "Resolve what needs you: fix round and merge",
        long: false,
      },
    ]);
  });

  it("a create draws the same ends as what it adds", () => {
    const record = proposedRecord({
      changes: changes.map(({ path, label, before }) => ({
        path,
        label,
        operation: "create" as const,
        after: before,
      })),
      action: "create",
      kind: "link",
      objectRefs,
    });
    expect(record?.op).toBe("create");
    expect(record?.fields.map((f) => [f.label, f.op, f.before])).toEqual([
      ["From", "add", undefined],
      ["Relation", "add", undefined],
      ["To", "add", undefined],
    ]);
  });
});
