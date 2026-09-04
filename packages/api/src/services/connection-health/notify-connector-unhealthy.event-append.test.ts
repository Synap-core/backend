/**
 * S3 — promoting `connector.auth.expired` / `system.intelligence_degraded`
 * from notification-only to a domain-typed event on the spine.
 *
 * `notifyConnectorUnhealthy()` is the ONE function both alerts share (the IS
 * variant calls it with an overridden `notificationType`), so promoting it
 * here covers both. Everything except the mapping/event-append logic under
 * test is mocked — DB writes, Discord posting, and NotificationService are
 * not what this test is pinning.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createNotification: vi.fn(async () => "notif-1"),
  appendEvent: vi.fn(async (_event: Record<string, unknown>) => {}),
  dbUpdate: vi.fn(() => ({
    set: () => ({ where: async () => {} }),
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
  watermarkMetadata: { connectionHealth: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.createNotification.mockResolvedValue("notif-1");
  h.appendEvent.mockResolvedValue(undefined);
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
    // Already nudged 1 minute ago — well inside the 6h cooldown.
    const recent = await notifyConnectorUnhealthy({
      ...baseOpts,
      watermarkMetadata: {
        connectionHealth: { google: { lastNotifiedMs: Date.now() - 60_000 } },
      },
    });

    expect(recent).toBe(false);
    expect(h.createNotification).not.toHaveBeenCalled();
    expect(h.appendEvent).not.toHaveBeenCalled();
  });

  it("never throws when the event append fails", async () => {
    h.appendEvent.mockRejectedValue(new Error("boom"));
    await expect(notifyConnectorUnhealthy(baseOpts)).resolves.toBe(true);
  });
});
