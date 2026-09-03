/**
 * The per-scope role floor for a renderer binding.
 *
 * The three scopes reach three different blast radii, so they get three
 * different floors — and the two that matter most are the ones this asserts:
 * a user cannot write the pod, and a non-editor cannot write a workspace.
 */

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

  it("refuses writing into someone else's personal scope", async () => {
    await expect(
      assertMayBindRenderer({
        userId: "u-1",
        scope: "user",
        workspaceId: null,
        targetUserId: "u-2",
      })
    ).rejects.toThrow(/only be written for yourself/);
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
