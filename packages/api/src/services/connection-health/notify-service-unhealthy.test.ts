import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The IS health cron computed "degraded" every 2 minutes and only logged it —
 * an 8-day agent outage stayed invisible. These tests pin the wiring that makes
 * the verdict leave the worker, and pin that it reuses the connector-health
 * door rather than growing a second alerting system.
 */
const h = vi.hoisted(() => ({
  notify: vi.fn(),
  resolveTool: vi.fn(),
  podOwner: vi.fn(),
  createNotification: vi.fn(),
  update: vi.fn(),
}));

vi.mock("./notify-connector-unhealthy.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./notify-connector-unhealthy.js")>();
  // Keep the REAL resolveNoticeChannelId — it is decision logic under test.
  return { ...actual, notifyConnectorUnhealthy: h.notify };
});
vi.mock("../tools/resolve-tool.js", () => ({ resolveTool: h.resolveTool }));
vi.mock("../capabilities/pod-owner.js", () => ({
  resolvePodOwnerUserId: h.podOwner,
}));

import { notifyIntelligenceServiceUnhealthy } from "./notify-service-unhealthy.js";
import { NOTIFICATION_REGISTRY_MAP } from "../../notifications/registry.js";

const baseInput = {
  serviceRowId: "is-row-1",
  serviceId: "synap-is",
  serviceName: "Synap Intelligence",
  healthStatus: "degraded",
  metadata: { connectionHealth: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.podOwner.mockResolvedValue("user-1");
  h.resolveTool.mockResolvedValue({
    id: "tool-1",
    createdBy: "user-1",
    workspaceId: "ws-1",
    metadata: { discord: { feedbackChannel: "chan-9" } },
  });
  h.notify.mockResolvedValue(true);
});

describe("intelligence health nudge", () => {
  it("routes through the shared connector-health door", async () => {
    await notifyIntelligenceServiceUnhealthy({
      ...baseInput,
      detail: "agentTurns: 402 Insufficient Balance",
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    const opts = h.notify.mock.calls[0]![0];
    // Watermark lives on the IS row, not a tools row it does not have.
    expect(opts.watermarkTable).toBe("intelligence_services");
    expect(opts.watermarkToolId).toBe("is-row-1");
    // Dedup key is per service, so two services alert independently.
    expect(opts.connectorKey).toBe("intelligence:synap-is");
    // NOT the connector.auth.expired template — nothing verified a credential.
    expect(opts.notificationType).toBe("system.intelligence_degraded");
    expect(opts.errorMessage).toBe("agentTurns: 402 Insufficient Balance");
  });

  it("carries the /health evidence into the Discord notice", async () => {
    await notifyIntelligenceServiceUnhealthy({
      ...baseInput,
      detail: "agentTurns: 402 Insufficient Balance",
    });
    const opts = h.notify.mock.calls[0]![0];
    expect(opts.noticeMessage).toContain("402 Insufficient Balance");
    expect(opts.noticeMessage).not.toMatch(/needs reconnect/i);
  });

  it("says so honestly when /health gave no detail", async () => {
    await notifyIntelligenceServiceUnhealthy(baseInput);
    const opts = h.notify.mock.calls[0]![0];
    expect(opts.errorMessage).toMatch(/no further detail/);
    expect(opts.errorMessage).not.toMatch(/credential|expired|overload/i);
  });

  it("posts to the operator's notice channel when configured", async () => {
    await notifyIntelligenceServiceUnhealthy(baseInput);
    expect(h.notify.mock.calls[0]![0].discordTeamChannelId).toBe("chan-9");
  });

  it("still notifies in-app when no discord tool is configured", async () => {
    h.resolveTool.mockResolvedValue(null);
    await notifyIntelligenceServiceUnhealthy(baseInput);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0].discordTeamChannelId).toBeUndefined();
  });

  it("is a no-op on a pre-bootstrap pod with no owner", async () => {
    h.podOwner.mockResolvedValue(null);
    expect(await notifyIntelligenceServiceUnhealthy(baseInput)).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("never throws — a health tick must not fail because alerting did", async () => {
    h.notify.mockRejectedValue(new Error("boom"));
    expect(await notifyIntelligenceServiceUnhealthy(baseInput)).toBe(false);
  });

  it("uses a notification type the registry actually knows", () => {
    // NotificationService.create() silently SKIPS unknown types, so a typo here
    // would make the whole alert vanish exactly like the log line it replaces.
    const def = NOTIFICATION_REGISTRY_MAP.get("system.intelligence_degraded");
    expect(def).toBeDefined();
    expect(def!.bodyTemplate).toContain("{{errorMessage}}");
  });
});
