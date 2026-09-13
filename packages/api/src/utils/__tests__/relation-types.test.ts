/**
 * The relation vocabulary validator: an unknown slug is REJECTED with the valid
 * list (never coerced to `relates_to`), and a failed defs read FAILS every edge
 * with the read error (never folds into a calm fallback vocabulary).
 *
 * Driven through the REAL `RelationDefRepository.list` over a fake db whose
 * `findMany` returns rows — so the dedupe/override logic and the repository
 * call are both on the path under test.
 */

import { describe, it, expect, vi } from "vitest";
import {
  listEffectiveRelationTypes,
  loadRelationTypeValidator,
  UnknownRelationTypeError,
} from "../relation-types.js";

function row(slug: string, workspaceId: string | null, extra = {}) {
  return {
    id: `${slug}-${workspaceId ?? "base"}`,
    slug,
    displayName: slug,
    description: null,
    workspaceId,
    userId: "u",
    uiHints: {},
    isDirectional: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

function fakeDb(findMany: () => Promise<unknown[]>) {
  return { query: { relationDefs: { findMany } } } as never;
}

describe("loadRelationTypeValidator", () => {
  const db = fakeDb(async () => [
    row("works_at", null),
    row("relates_to", null),
    row("mentors", "ws-1"),
  ]);

  it("passes a def slug and a built-in through unchanged", async () => {
    const validate = await loadRelationTypeValidator(db, "ws-1");
    expect(validate("works_at")).toBe("works_at");
    expect(validate("mentors")).toBe("mentors");
    expect(validate("same_subject")).toBe("same_subject");
    expect(validate("embedded_in")).toBe("embedded_in");
  });

  it("REJECTS an unknown slug naming it and the valid slugs — never coerces", async () => {
    const validate = await loadRelationTypeValidator(db, "ws-1");
    let thrown: unknown;
    try {
      validate("related_to");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownRelationTypeError);
    const message = (thrown as Error).message;
    expect(message).toContain('"related_to"');
    expect(message).toContain("mentors, relates_to, works_at");
  });

  it("a FAILED read fails every edge with the read error — not a {relates_to} fallback", async () => {
    const validate = await loadRelationTypeValidator(
      fakeDb(async () => {
        throw new Error("connection refused");
      }),
      null
    );
    for (const slug of ["relates_to", "works_at", "anything"]) {
      expect(() => validate(slug)).toThrow(
        /could not be read.*connection refused/
      );
    }
  });
});

describe("listEffectiveRelationTypes", () => {
  it("one row per slug, the workspace def overriding the base def", async () => {
    const findMany = vi.fn(async () => [
      row("works_at", null, { displayName: "Base" }),
      row("works_at", "ws-1", {
        displayName: "Override",
        uiHints: { inverseLabel: "Employs" },
      }),
      row("blocks", null),
    ]);
    const types = await listEffectiveRelationTypes(fakeDb(findMany), "ws-1");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(types.map((t) => [t.slug, t.displayName, t.inverseLabel])).toEqual([
      ["blocks", "blocks", null],
      ["works_at", "Override", "Employs"],
    ]);
  });
});
