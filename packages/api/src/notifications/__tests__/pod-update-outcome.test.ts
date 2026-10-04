/**
 * U4 pod-side: the owner hears about an update that did not land, once per
 * update id per admin, through NotificationService.create.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap/database", () => ({
  db: {},
  and: vi.fn(),
  eq: vi.fn(),
  notifications: {},
}));
vi.mock("../NotificationService.js", () => ({ NotificationService: { create: vi.fn() } }));
vi.mock("../../services/capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: vi.fn(),
}));

const {
  notifyPodUpdateOutcome,
  describePodUpdateOutcome,
  POD_UPDATE_FAILED_NOTIFICATION_TYPE,
} = await import("../pod-update-outcome.js");
const { getNotificationDef } = await import("../registry.js");

const ROLLED_BACK = {
  updateId: "u-1",
  status: "rolled_back",
  from: "v1",
  to: "v2",
  reason: "backend migration failed",
  dbRestored: true,
};

function fakeDeps(admins: string[]) {
  const rows: Array<{ userId: string; sourceId: string }> = [];
  return {
    rows,
    deps: {
      recipients: async () => admins,
      alreadyNotified: async (sourceId: string) =>
        new Set(rows.filter((r) => r.sourceId === sourceId).map((r) => r.userId)),
      create: async (input: { userId: string; sourceId?: string }) => {
        rows.push({ userId: input.userId, sourceId: input.sourceId! });
        return `n-${rows.length}`;
      },
    },
  };
}

describe("pod.update_failed", () => {
  // Catches: a producer whose type the registry does not know — create() would skip it.
  it("is a registered type", () => {
    expect(getNotificationDef(POD_UPDATE_FAILED_NOTIFICATION_TYPE)).toBeTruthy();
  });

  it("notifies every admin once per update id", async () => {
    const { rows, deps } = fakeDeps(["owner", "admin"]);
    expect(await notifyPodUpdateOutcome(ROLLED_BACK, deps as never)).toBe(2);
    // Re-boot reading the same file: nothing new.
    expect(await notifyPodUpdateOutcome(ROLLED_BACK, deps as never)).toBe(0);
    expect(rows).toHaveLength(2);
    // A different update id is news again.
    expect(await notifyPodUpdateOutcome({ ...ROLLED_BACK, updateId: "u-2" }, deps as never)).toBe(2);
  });

  // Catches: the bell ringing for a good update.
  it("is silent on success and on an aborted (nothing-changed) run", async () => {
    const { rows, deps } = fakeDeps(["owner"]);
    await notifyPodUpdateOutcome({ ...ROLLED_BACK, status: "succeeded" }, deps as never);
    await notifyPodUpdateOutcome({ ...ROLLED_BACK, status: "aborted" }, deps as never);
    expect(rows).toHaveLength(0);
  });

  it("says a failed rollback needs attention, and never claims the data is safe", () => {
    const d = describePodUpdateOutcome({ ...ROLLED_BACK, status: "rollback_failed" })!;
    expect(d.headline).toMatch(/needs attention/);
    expect(d.detail).not.toMatch(/restored|safe/);
    expect(describePodUpdateOutcome(ROLLED_BACK)!.detail).toMatch(/restored/);
  });
});
