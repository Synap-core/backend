/**
 * The document scope + refresher reading (0387): the parse, the five kinds,
 * and the READ FLOOR — a scope naming a space, project, goal or session the
 * writer cannot read is refused with the same words as one that does not
 * exist. Driven through a fake floor (which ids the writer can read); the
 * floor's own predicate is the access layer's suite.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../access/index.js", () => ({
  AccessContext: { operator: () => ({}) },
  scopedDb: () => ({ findMany: async () => [] }),
}));

import {
  resolveDocumentRefresher,
  resolveDocumentScope,
  resolveDocumentScopeFields,
  type DocumentScopeFloor,
  type ScopeObjectKind,
} from "./document-scope.js";

const W = "11111111-1111-4111-8111-111111111111";
const W_OTHER = "11111111-1111-4111-8111-999999999999";
const P = "22222222-2222-4222-8222-222222222222";
const P_HIDDEN = "22222222-2222-4222-8222-999999999999";
const T = "33333333-3333-4333-8333-333333333333";
const S = "44444444-4444-4444-8444-444444444444";
const A = "55555555-5555-4555-8555-555555555555";
const A_HIDDEN = "55555555-5555-4555-8555-999999999999";

function floor(readable: string[]): DocumentScopeFloor & { asked: string[] } {
  const can = new Set(readable);
  const asked: string[] = [];
  return {
    asked,
    async workspaces(ids) {
      asked.push(...ids.map((id) => `workspace:${id}`));
      return new Set(ids.filter((id) => can.has(id)));
    },
    async visible(kind: ScopeObjectKind, ids) {
      asked.push(...ids.map((id) => `${kind}:${id}`));
      return new Set(ids.filter((id) => can.has(id)));
    },
  };
}

describe("resolveDocumentScope", () => {
  it("stores what it read, for every document kind the writer can read", async () => {
    const f = floor([W, P, T, S]);
    for (const scope of [
      { kind: "pod" },
      { kind: "workspace", workspaceId: W, projectId: P },
      { kind: "project", projectId: P },
      { kind: "track", trackId: T },
      { kind: "session", sessionId: S, projectId: P },
    ]) {
      expect(await resolveDocumentScope(scope, f)).toEqual(scope);
    }
  });

  it("null clears the scope", async () => {
    expect(await resolveDocumentScope(null, floor([]))).toBeNull();
  });

  it("the floor asks about EVERY id the scope names, containers included", async () => {
    const f = floor([W, P]);
    await resolveDocumentScope(
      { kind: "workspace", workspaceId: W, projectId: P },
      f
    );
    expect(f.asked.sort()).toEqual([`project:${P}`, `workspace:${W}`]);
  });

  it("refuses a space the writer is not a member of", async () => {
    await expect(
      resolveDocumentScope(
        { kind: "workspace", workspaceId: W_OTHER },
        floor([W])
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a project hidden behind a readable space, with the not-found words", async () => {
    const err = await resolveDocumentScope(
      { kind: "workspace", workspaceId: W, projectId: P_HIDDEN },
      floor([W])
    ).catch((e) => e);
    expect(err).toMatchObject({ code: "FORBIDDEN" });
    expect(String(err.message)).toMatch(/cannot read, or that does not exist/);
  });

  it("refuses a malformed scope and a kind a document does not read through", async () => {
    await expect(
      resolveDocumentScope({ kind: "project" }, floor([]))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      resolveDocumentScope({ kind: "pipeline", profileSlug: "lead" }, floor([]))
    ).rejects.toThrow(/a document reads through/);
  });
});

describe("resolveDocumentRefresher", () => {
  it("binds an automation the writer can see; null unbinds", async () => {
    expect(await resolveDocumentRefresher(A, floor([A]))).toBe(A);
    expect(await resolveDocumentRefresher(null, floor([]))).toBeNull();
  });

  it("refuses an automation the writer cannot see, and a non-id", async () => {
    await expect(
      resolveDocumentRefresher(A_HIDDEN, floor([A]))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      resolveDocumentRefresher("daily-brief", floor([]))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("resolveDocumentScopeFields", () => {
  it("absent fields stay absent (no change); present ones are read", async () => {
    expect(await resolveDocumentScopeFields({}, floor([]))).toEqual({});
    expect(
      await resolveDocumentScopeFields(
        { scope: { kind: "pod" }, refreshAutomationId: null },
        floor([])
      )
    ).toEqual({ scope: { kind: "pod" }, refreshAutomationId: null });
  });
});
