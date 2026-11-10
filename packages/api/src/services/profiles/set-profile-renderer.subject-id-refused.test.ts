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

describe("the per-object exception: a playbook or a view (renderer-targets.ts)", () => {
  it("is held to the target's own slots and scopes, before any DB round trip", async () => {
    await expect(
      setProfileRenderer({
        ...baseInput,
        profileSlug: "playbook",
        slot: "card",
        subjectId: "playbook-1",
      })
    ).rejects.toThrow(/A playbook has no 'card' renderer slot/);
    await expect(
      setProfileRenderer({
        ...baseInput,
        profileSlug: "view",
        slot: "list",
        subjectId: "view-1",
      })
    ).rejects.toThrow(/A view has no 'list' renderer slot/);
  });

  it("must name its object: no subjectId is refused, before any DB round trip", async () => {
    for (const profileSlug of ["playbook", "view"] as const) {
      await expect(
        setProfileRenderer({ ...baseInput, profileSlug, subjectId: null })
      ).rejects.toThrow(/pass its id as subjectId/);
      await expect(
        setProfileRenderer({ ...baseInput, profileSlug })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("a capability is NOT a renderer_bindings per-object target (it has its own page-set door)", async () => {
    await expect(
      setProfileRenderer({
        ...baseInput,
        profileSlug: "capability",
        subjectId: "cap-1",
      })
    ).rejects.toThrow(/whole-kind only/);
  });
});
