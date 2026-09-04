/**
 * S3 — promoting `system.capability_update_available` from notification-only
 * to a domain-typed event on the spine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createNotification: vi.fn(async () => "notif-1"),
  appendEvent: vi.fn(async (_event: Record<string, unknown>) => {}),
  existingOpen: undefined as { id: string } | undefined,
  podOwner: vi.fn(async () => "owner-1"),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      ...actual.db,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (h.existingOpen ? [h.existingOpen] : []),
          }),
        }),
      }),
    },
    eventRepository: { ...actual.eventRepository, append: h.appendEvent },
  };
});

vi.mock("../../notifications/NotificationService.js", () => ({
  NotificationService: { create: h.createNotification },
}));

vi.mock("./pod-owner.js", () => ({ resolvePodOwnerUserId: h.podOwner }));

import {
  notifyCapabilityUpdatesAvailable,
  CAPABILITY_UPDATE_GROUP_KEY,
} from "./notify-capability-updates.js";
import type { CapabilityReconcileReport } from "./reconcile-capabilities-to-templates.js";

const report = {
  updatesAvailable: [{ name: "gmail-send" }, { name: "cal-sync" }],
} as unknown as CapabilityReconcileReport;

beforeEach(() => {
  vi.clearAllMocks();
  h.createNotification.mockResolvedValue("notif-1");
  h.appendEvent.mockResolvedValue(undefined);
  h.podOwner.mockResolvedValue("owner-1");
  h.existingOpen = undefined;
});

describe("notifyCapabilityUpdatesAvailable — event-spine promotion", () => {
  it("appends capability.update.completed with the stable group key as subject", async () => {
    await notifyCapabilityUpdatesAvailable(report);

    expect(h.appendEvent).toHaveBeenCalledTimes(1);
    const event = h.appendEvent.mock.calls[0]![0];
    expect(event.type).toBe("capability.update.completed");
    expect(event.subjectType).toBe("system");
    expect(event.subjectId).toBe(CAPABILITY_UPDATE_GROUP_KEY);
    expect(event.userId).toBe("owner-1");
    expect(event.source).toBe("system");
  });

  it("skips the event append too when an open notification already covers this drift", async () => {
    h.existingOpen = { id: "existing-notif" };
    await notifyCapabilityUpdatesAvailable(report);

    expect(h.createNotification).not.toHaveBeenCalled();
    expect(h.appendEvent).not.toHaveBeenCalled();
  });

  it("no-ops with nothing to notify", async () => {
    await notifyCapabilityUpdatesAvailable({
      updatesAvailable: [],
    } as unknown as CapabilityReconcileReport);

    expect(h.createNotification).not.toHaveBeenCalled();
    expect(h.appendEvent).not.toHaveBeenCalled();
  });
});
