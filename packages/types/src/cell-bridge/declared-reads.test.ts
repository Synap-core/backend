/**
 * Declared reads: a subset of the ceiling, checked by the pod's frame read
 * door. Each row rules out a wrong answer: a read the declaration does not
 * name passing, a pinned param read with another value passing, a malformed
 * stored declaration reading as "undeclared" (everything allowed).
 */
import { describe, expect, it } from "vitest";
import {
  isReadDeclared,
  parseDeclaredReads,
  parseDeclaredWrites,
  storedDeclaredReads,
} from "./index.js";

describe("parseDeclaredReads: a subset of the ceiling", () => {
  it("takes ops of the table, with params of the op's own list", () => {
    expect(
      parseDeclaredReads([
        { op: "entities.list", params: { profileSlug: "deal" } },
        { op: "documents.get", params: { documentId: "*" } },
        { op: "lifecycle.home" },
      ])
    ).toEqual({
      ok: true,
      value: [
        { op: "entities.list", params: { profileSlug: "deal" } },
        { op: "documents.get", params: { documentId: "*" } },
        { op: "lifecycle.home" },
      ],
    });
  });

  it("refuses an op outside the ceiling", () => {
    const r = parseDeclaredReads([{ op: "users.list" }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("is not a frame read");
  });

  it("refuses a param the op does not take (the lens is never one)", () => {
    const r = parseDeclaredReads([
      { op: "entities.list", params: { workspaceId: "x" } },
    ]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("is not a param of");
  });

  it("refuses a non-string or empty value, and a non-list", () => {
    expect(
      parseDeclaredReads([{ op: "entities.list", params: { limit: 5 } }]).ok
    ).toBe(false);
    expect(
      parseDeclaredReads([{ op: "entities.list", params: { profileSlug: "" } }])
        .ok
    ).toBe(false);
    expect(parseDeclaredReads({ op: "entities.list" }).ok).toBe(false);
  });

  it("refuses more than 50 entries", () => {
    expect(
      parseDeclaredReads(
        Array.from({ length: 51 }, () => ({ op: "lifecycle.home" }))
      ).ok
    ).toBe(false);
  });
});

describe("parseDeclaredWrites", () => {
  it("takes ops of the write table only", () => {
    expect(parseDeclaredWrites([{ op: "create_entity" }])).toEqual({
      ok: true,
      value: [{ op: "create_entity" }],
    });
    expect(parseDeclaredWrites([{ op: "delete_everything" }]).ok).toBe(false);
  });
});

describe("storedDeclaredReads", () => {
  it("null or absent: undeclared", () => {
    expect(storedDeclaredReads(null)).toBeNull();
    expect(storedDeclaredReads(undefined)).toBeNull();
  });
  it("a stored value that does not parse declares nothing allowed, never undeclared", () => {
    expect(storedDeclaredReads([{ op: "users.list" }])).toEqual([]);
    expect(storedDeclaredReads("everything")).toEqual([]);
  });
});

describe("isReadDeclared", () => {
  const declared = [
    { op: "entities.list" as const, params: { profileSlug: "deal" } },
    { op: "views.execute" as const, params: { id: "*" } },
  ];

  it("the declared op with its pinned value: allowed, other params free", () => {
    expect(
      isReadDeclared(declared, "entities.list", {
        profileSlug: "deal",
        limit: 10,
      })
    ).toBe(true);
  });

  it("an op not declared: refused", () => {
    expect(isReadDeclared(declared, "documents.get", { documentId: "d" })).toBe(
      false
    );
  });

  it("the pinned param with another value, or missing: refused", () => {
    expect(
      isReadDeclared(declared, "entities.list", { profileSlug: "person" })
    ).toBe(false);
    expect(isReadDeclared(declared, "entities.list", {})).toBe(false);
  });

  it('"*": any value, or none', () => {
    expect(isReadDeclared(declared, "views.execute", { id: "v1" })).toBe(true);
    expect(isReadDeclared(declared, "views.execute", {})).toBe(true);
  });

  it("an empty declaration refuses everything", () => {
    expect(isReadDeclared([], "lifecycle.home", {})).toBe(false);
  });

  it("values compare as strings", () => {
    expect(
      isReadDeclared(
        [{ op: "entities.list", params: { limit: "10" } }],
        "entities.list",
        { limit: 10 }
      )
    ).toBe(true);
  });
});
