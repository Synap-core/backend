/**
 * TRIPWIRE — renderer bindings are WHOLE-KIND only (decision 2026-09-07).
 *
 * `setProfileRenderer` is the one write door into `renderer_bindings`. A
 * non-null `subjectId` (a per-object binding) is refused unconditionally, for
 * every scope, before any DB round trip — see the schema header of
 * `renderer-bindings.ts` for the prior-art rationale.
 *
 * The refusal runs before `getDb()`, so this suite needs no database mock: a
 * call that reaches past it without throwing would otherwise crash on the
 * unmocked `getDb()` / `assertMayBindRenderer`, which is itself a second
 * signal that the guard fired first.
 */
import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";

import { setProfileRenderer } from "./set-profile-renderer.js";

const baseInput = {
  userId: "u-1",
  workspaceId: "ws-1",
  profileSlug: "task",
  slot: "detail" as const,
  ref: { kind: "cell" as const, cellKey: "some-cell", props: {} },
  scope: "workspace" as const,
};

describe("setProfileRenderer refuses a per-object binding", () => {
  it("throws BAD_REQUEST for a non-null subjectId, for every scope", async () => {
    for (const scope of ["user", "workspace", "pod"] as const) {
      await expect(
        setProfileRenderer({
          ...baseInput,
          scope,
          workspaceId: scope === "workspace" ? "ws-1" : null,
          subjectId: "entity-123",
        })
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
  });

  it("the error is a TRPCError naming the whole-kind decision", async () => {
    await expect(
      setProfileRenderer({ ...baseInput, subjectId: "entity-123" })
    ).rejects.toThrow(/whole-kind only/);
    try {
      await setProfileRenderer({ ...baseInput, subjectId: "entity-123" });
      expect.unreachable("expected setProfileRenderer to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
    }
  });
});
