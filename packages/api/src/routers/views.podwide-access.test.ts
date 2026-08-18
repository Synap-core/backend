/**
 * POD-WIDE views: readable but permanently UNWRITABLE (the same read-aware /
 * write-blind split that broke pod-wide proposal approval).
 *
 * THE BUG. `views.get` / `views.getContent` carried the pod-wide OWNER branch
 * (`!view.workspaceId && view.userId !== ctx.userId → FORBIDDEN`), so a user
 * could open their own pod-personal view. Five sibling doors —
 * `save`, `update`, `delete`, `reorderEntity`, `getAvailableColumns` — instead
 * hard-threw `FORBIDDEN "View must belong to a workspace"` for ANY NULL
 * workspace. Net effect: your own pod-wide view could be read forever and
 * never edited, reordered, or deleted, by anyone at all.
 *
 * Both halves now go through ONE predicate, `assertViewAccess`.
 *
 * THE PREDICATE (and why it cannot over-admit):
 *   · `view.workspaceId` set  → `verifyPermission` at the requested level —
 *     byte-identical to what each call site already called. UNCHANGED.
 *   · `view.workspaceId` NULL → `view.userId === callerUserId` and nothing
 *     else. `views.userId` is `notNull` in the schema ("Creator"), so this is a
 *     total, single-identity comparison with no null-match escape hatch. It
 *     admits strictly ONE user where the write doors previously admitted NOBODY
 *     and the read doors already admitted exactly that same one user — so no
 *     principal gains access that the read side did not already grant.
 *
 * The pod-wide branch touches no database, so these assertions are executable
 * without Postgres. The workspace branch is untouched behaviour and is pinned
 * structurally below (every former hard-throw site now routes through the one
 * predicate) rather than re-tested through a live `verifyPermission`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { assertViewAccess } from "./views.js";

const OWNER = "view-owner-user";
const STRANGER = "some-other-pod-user";

const podWideView: { workspaceId: string | null; userId: string } = {
  workspaceId: null,
  userId: OWNER,
};

describe("assertViewAccess — pod-wide (NULL workspaceId) view", () => {
  for (const level of ["read", "write"] as const) {
    it(`ALLOWS the OWNER to ${level} their own pod-wide view`, async () => {
      await expect(
        assertViewAccess(podWideView, OWNER, level)
      ).resolves.toBeUndefined();
    });

    it(`DENIES a non-owner ${level} on someone else's pod-wide view`, async () => {
      await expect(
        assertViewAccess(podWideView, STRANGER, level)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }

  it("owner match is by identity, not by emptiness — a blank caller is denied", async () => {
    await expect(
      assertViewAccess(podWideView, "", "write")
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("every views door goes through the ONE predicate", () => {
  const SRC = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "views.ts"),
    "utf-8"
  );

  it("the hard-throw that made pod-wide views unwritable is gone", () => {
    // The doc comment above `assertViewAccess` quotes the old message once;
    // no PROCEDURE may still throw it.
    const throwsIt = SRC.split("\n").filter(
      (l) =>
        l.includes('message: "View must belong to a workspace"') ||
        l.includes('"View must belong to a workspace",')
    );
    expect(throwsIt).toEqual([]);
  });

  it("no door hand-rolls its own view permission check any more", () => {
    // `verifyPermission({ … workspace: { id: view.workspaceId } … })` used to
    // be copy-pasted into seven procedures; it now exists exactly once, inside
    // `assertViewAccess`.
    expect(SRC.match(/workspace: \{ id: view\.workspaceId \}/g)?.length).toBe(
      1
    );
  });

  it("all seven view doors call assertViewAccess", () => {
    expect(
      SRC.match(/await assertViewAccess\(view, ctx\.userId, "/g)?.length
    ).toBe(7);
  });
});
