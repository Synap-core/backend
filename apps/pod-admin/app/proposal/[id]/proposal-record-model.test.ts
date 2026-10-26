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
