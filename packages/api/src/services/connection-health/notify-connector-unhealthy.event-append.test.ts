/**
 * S3 — promoting `connector.auth.expired` / `system.intelligence_degraded`
 * from notification-only to a domain-typed event on the spine.
 *
 * `notifyConnectorUnhealthy()` is the ONE function both alerts share (the IS
 * variant calls it with an overridden `notificationType`), so promoting it
 * here covers both. Everything except the mapping/event-append logic under
 * test is mocked — DB writes, Discord posting, and NotificationService are
 * not what this test is pinning. The cooldown claim against a real database
 * is pinned by `notify-connector-unhealthy.claim.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createNotification: vi.fn(async () => "notif-1"),
  appendEvent: vi.fn(async (_event: Record<string, unknown>) => {}),
  // The cooldown claim: rows returned = this call won the window.
  claimed: [{ id: "tool-1" }] as Array<{ id: string }>,
  dbUpdate: vi.fn(() => ({
    set: () => ({ where: () => ({ returning: async () => h.claimed }) }),
  })),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { ...actual.db, update: h.dbUpdate },
    eventRepository: { ...actual.eventRepository, append: h.appendEvent },
  };
});

vi.mock("../../notifications/NotificationService.js", () => ({
  NotificationService: { create: h.createNotification },
}));

vi.mock("../channels/channel-origin.js", () => ({
  recordChannelOrigin: vi.fn(async () => {}),
}));

import { notifyConnectorUnhealthy } from "./notify-connector-unhealthy.js";

const baseOpts = {
  connectorKey: "google",
  connectorName: "Google Workspace",
  reconnectHint: "Reconnect via Settings",
  userId: "user-1",
  workspaceId: "ws-1",
  watermarkToolId: "tool-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.createNotification.mockResolvedValue("notif-1");
  h.appendEvent.mockResolvedValue(undefined);
  h.claimed = [{ id: "tool-1" }];
});

describe("notifyConnectorUnhealthy — event-spine promotion", () => {
  it("appends connector.auth_expire.completed for the default connector.auth.expired alert", async () => {
    await notifyConnectorUnhealthy(baseOpts);

    expect(h.appendEvent).toHaveBeenCalledTimes(1);
    const event = h.appendEvent.mock.calls[0]![0];
    expect(event.type).toBe("connector.auth_expire.completed");
    expect(event.subjectType).toBe("connector");
    expect(event.subjectId).toBe("tool-1"); // same subject the watermark uses
    expect(event.source).toBe("system");
  });

  it("appends intelligence.degrade.completed when the caller overrides notificationType", async () => {
    await notifyConnectorUnhealthy({
      ...baseOpts,
      watermarkTable: "intelligence_services",
      notificationType: "system.intelligence_degraded",
    });

    const event = h.appendEvent.mock.calls[0]![0];
    expect(event.type).toBe("intelligence.degrade.completed");
    expect(event.subjectType).toBe("intelligence_service");
    expect(event.subjectId).toBe("tool-1");
  });

  it("dedupes the event append via the SAME 6h cooldown as the notification", async () => {
    // The claim updated no row: the window is already held (nudged inside 6h).
    h.claimed = [];
    const recent = await notifyConnectorUnhealthy(baseOpts);

    expect(recent).toBe(false);
    expect(h.createNotification).not.toHaveBeenCalled();
    expect(h.appendEvent).not.toHaveBeenCalled();
  });

  it("never throws when the event append fails", async () => {
    h.appendEvent.mockRejectedValue(new Error("boom"));
    await expect(notifyConnectorUnhealthy(baseOpts)).resolves.toBe(true);
  });
});
