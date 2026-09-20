/**
 * The narrowing, at the shapes a jsonb column can actually hand you.
 *
 * The packet's PGlite suite
 * (`api/.../__tests__/continuation-resume.pglite.test.ts`) drives the happy
 * path through the real producer; what it cannot reach is a `metadata` column
 * holding something the producer never wrote — a hand-edited row, an older
 * shape, a `suspended` that is a string. Each of those must read as "no note",
 * never as a half-trusted object and never as a throw.
 */

import { describe, it, expect } from "vitest";
import { readSuspendedNote, readSuspendedIntent } from "./suspended.js";

const WRITTEN = {
  suspended: {
    intent: "  Draft the pricing page  ",
    childSessionId: "child-1",
    at: "2026-09-20T10:00:00.000Z",
  },
};

describe("readSuspendedNote", () => {
  it("reads what session-spawn writes, trimmed", () => {
    expect(readSuspendedNote(WRITTEN)).toEqual({
      intent: "Draft the pricing page",
      childSessionId: "child-1",
      at: "2026-09-20T10:00:00.000Z",
    });
    expect(readSuspendedIntent(WRITTEN)).toBe("Draft the pricing page");
  });

  it("keeps the intent when the note names no child and no time", () => {
    expect(readSuspendedNote({ suspended: { intent: "Ship it" } })).toEqual({
      intent: "Ship it",
      childSessionId: null,
      at: null,
    });
  });

  it.each([
    ["null metadata", null],
    ["undefined metadata", undefined],
    ["a string metadata", "suspended"],
    ["no suspended key", { runManifest: {} }],
    ["suspended as a string", { suspended: "Draft the pricing page" }],
    ["suspended as null", { suspended: null }],
    ["no intent", { suspended: { childSessionId: "child-1" } }],
    ["a non-string intent", { suspended: { intent: 42 } }],
    ["a blank intent", { suspended: { intent: "   " } }],
  ])("reads %s as NO note", (_label, metadata) => {
    expect(readSuspendedNote(metadata)).toBeUndefined();
    expect(readSuspendedIntent(metadata)).toBeUndefined();
  });

  it("does not trust a non-string childSessionId or at", () => {
    expect(
      readSuspendedNote({
        suspended: { intent: "Ship it", childSessionId: 7, at: 0 },
      })
    ).toEqual({ intent: "Ship it", childSessionId: null, at: null });
  });
});
