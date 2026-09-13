/**
 * `isPodAdmin` — the ONE pod-admin predicate (`assertPodAdmin` in trpc.ts and
 * the governance gate's rung-2.07 check both call it).
 *
 * The property that matters most is the one a refactor breaks silently: a
 * FAILED membership read must THROW, never fold into `false`. Folded, a
 * database outage reads as "this user is not an admin" — which at the gate
 * turns into a confident denial / proposal instead of a visible error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWorkspaceFindFirst, mockMemberFindFirst } = vi.hoisted(() => ({
  mockWorkspaceFindFirst: vi.fn(),
  mockMemberFindFirst: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    query: {
      workspaces: { findFirst: mockWorkspaceFindFirst },
      workspaceMembers: { findFirst: mockMemberFindFirst },
    },
  },
}));

import { isPodAdmin } from "./workspace-role.js";

describe("isPodAdmin", () => {
  beforeEach(() => {
    mockWorkspaceFindFirst
      .mockReset()
      .mockResolvedValue({ id: "pod-admin-ws" });
    mockMemberFindFirst.mockReset().mockResolvedValue(undefined);
  });

  it("true for an owner/admin member of the pod-admin workspace", async () => {
    mockMemberFindFirst.mockResolvedValue({ role: "admin" });
    await expect(isPodAdmin("u-1")).resolves.toBe(true);
  });

  it("false for a non-member, and false when no pod-admin workspace exists", async () => {
    await expect(isPodAdmin("u-1")).resolves.toBe(false);
    mockWorkspaceFindFirst.mockResolvedValue(undefined);
    await expect(isPodAdmin("u-1")).resolves.toBe(false);
    // The missing-workspace branch really short-circuited (non-vacuity).
    expect(mockMemberFindFirst).toHaveBeenCalledTimes(1);
  });

  it("a FAILED membership read throws — it never reads as 'not an admin'", async () => {
    mockMemberFindFirst.mockRejectedValue(new Error("connection terminated"));
    await expect(isPodAdmin("u-1")).rejects.toThrow("connection terminated");
  });

  it("a FAILED pod-admin-workspace read throws too", async () => {
    mockWorkspaceFindFirst.mockRejectedValue(
      new Error("connection terminated")
    );
    await expect(isPodAdmin("u-1")).rejects.toThrow("connection terminated");
  });
});
