/**
 * Decision 7 — a connector-health notice NAMES the connection it is about, so
 * the person's notify level for that account gates it. A connector's key is
 * its provider = the Connected page's `account:<provider>` key. An
 * intelligence service is no membrane connection and names none.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createNotification: vi.fn(async (_input: Record<string, unknown>) => "notif-1"),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      ...actual.db,
      update: () => ({ set: () => ({ where: async () => {} }) }),
    },
    eventRepository: { ...actual.eventRepository, append: async () => {} },
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

beforeEach(() => vi.clearAllMocks());

describe("notifyConnectorUnhealthy — names its connection", () => {
  it("a connector's notice names account:<provider>", async () => {
    await notifyConnectorUnhealthy(baseOpts);
    expect(h.createNotification.mock.calls[0]![0].connection).toEqual({
      kind: "account",
      id: "google",
    });
  });

  it("an intelligence service's notice names none (never gated)", async () => {
    await notifyConnectorUnhealthy({
      ...baseOpts,
      connectorKey: "intelligence:is-1",
      watermarkTable: "intelligence_services",
      notificationType: "system.intelligence_degraded",
    });
    expect(h.createNotification.mock.calls[0]![0].connection).toBeUndefined();
  });
});
