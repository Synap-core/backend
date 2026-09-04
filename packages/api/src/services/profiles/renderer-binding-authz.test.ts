/**
 * The per-scope role floor for a renderer binding.
 *
 * The three scopes reach three different blast radii, so they get three
 * different floors — and the two that matter most are the ones this asserts:
 * a user cannot write the pod, and a non-editor cannot write a workspace.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  isPodAdmin: vi.fn(),
  requireEditor: vi.fn(),
}));

vi.mock("../../utils/workspace-role.js", () => ({
  isPodAdmin: h.isPodAdmin,
}));
vi.mock("../../utils/workspace-permissions.js", () => ({
  requireEditor: h.requireEditor,
}));
// PARTIAL mock (importOriginal + spread) — a TOTAL replacement breaks the
// moment any module in the graph reaches for an export this suite never named
// (see the database-mock-total-ratchet tripwire). Only `db` is faked; the gate
// passes it straight to the mocked `requireEditor` and never dereferences it.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: {} };
});

const { assertMayBindRenderer } = await import("./renderer-binding-authz.js");

beforeEach(() => {
  h.isPodAdmin.mockReset();
  h.requireEditor.mockReset();
});

describe("scope: user", () => {
  it("allows the acting user to write their own override", async () => {
    await expect(
      assertMayBindRenderer({ userId: "u-1", scope: "user", workspaceId: null })
    ).resolves.toBeUndefined();
    // Personal scope asks nobody: no membership, no pod-admin round trip.
    expect(h.isPodAdmin).not.toHaveBeenCalled();
    expect(h.requireEditor).not.toHaveBeenCalled();
  });

  /**
   * The "someone else's personal scope" case is not a runtime branch, because
   * it is not reachable: `setProfileRenderer` is the only write door and it
   * derives the binding row's `userId` column from the ACTING identity. A
   * runtime mismatch check here had zero producers — it read like a floor while
   * being dead code.
   *
   * So the invariant is pinned where it actually lives. A source scan, because
   * the defect would be an EDIT to the call site (accepting a caller-supplied
   * user id), which no behavioural test of this module could ever observe.
   */
  it("the one write door derives the binding's user column from the actor", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./set-profile-renderer.ts", import.meta.url)),
      "utf8"
    );
    expect(
      /userId:\s*scope === "user" \? userId : null/.test(src),
      "setProfileRenderer no longer derives the user-scoped binding's userId " +
        "from the acting identity. A caller-supplied target user is an " +
        "invisible impersonation: the resolver would report the write as that " +
        "user's own preference. Restore the derivation, or bring back the " +
        "`targetUserId` floor in renderer-binding-authz.ts TOGETHER with it."
    ).toBe(true);
    // And no target-user input exists on the door to supply one from.
    expect(/targetUserId/.test(src)).toBe(false);
  });
});

describe("scope: pod", () => {
  it("refuses a non-pod-admin — a user cannot write the pod", async () => {
    h.isPodAdmin.mockResolvedValue(false);
    await expect(
      assertMayBindRenderer({ userId: "u-1", scope: "pod", workspaceId: null })
    ).rejects.toThrow(/pod administrators/);
  });

  it("allows a pod admin", async () => {
    h.isPodAdmin.mockResolvedValue(true);
    await expect(
      assertMayBindRenderer({ userId: "u-1", scope: "pod", workspaceId: null })
    ).resolves.toBeUndefined();
  });
});

describe("scope: workspace", () => {
  it("allows an editor of that workspace", async () => {
    h.requireEditor.mockResolvedValue({ role: "editor" });
    await expect(
      assertMayBindRenderer({
        userId: "u-1",
        scope: "workspace",
        workspaceId: "ws-1",
      })
    ).resolves.toBeUndefined();
    expect(h.requireEditor).toHaveBeenCalledWith({}, "ws-1", "u-1");
    expect(h.isPodAdmin).not.toHaveBeenCalled();
  });

  it("refuses a non-editor who is not a pod admin", async () => {
    h.requireEditor.mockRejectedValue(new Error("Requires editor role"));
    h.isPodAdmin.mockResolvedValue(false);
    await expect(
      assertMayBindRenderer({
        userId: "u-1",
        scope: "workspace",
        workspaceId: "ws-1",
      })
    ).rejects.toThrow(/Requires editor role/);
  });

  it("admits a pod admin who holds no member row (the sovereign-pod owner)", async () => {
    h.requireEditor.mockRejectedValue(new Error("Workspace not found"));
    h.isPodAdmin.mockResolvedValue(true);
    await expect(
      assertMayBindRenderer({
        userId: "u-1",
        scope: "workspace",
        workspaceId: "ws-1",
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a workspace binding with no workspaceId", async () => {
    await expect(
      assertMayBindRenderer({
        userId: "u-1",
        scope: "workspace",
        workspaceId: null,
      })
    ).rejects.toThrow(/workspaceId is required/);
  });
});
