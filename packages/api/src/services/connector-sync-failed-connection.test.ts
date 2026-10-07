/**
 * Decision 7 — a failing sync's notice NAMES the account it is about
 * (`account:<provider>`, the provider from the Nango connection id
 * `{userId}:{podId}:{provider}`), so the person's notify level for that
 * account gates it in `NotificationService.create`.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(async (_input: Record<string, unknown>) => "notif-1"),
}));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: { create: h.create },
}));

import { syncConnectionToImport } from "./connector-import-bridge.js";

describe("connector.sync.failed — names its account", () => {
  it("passes account:<provider> to the notifier", async () => {
    // A connector with no read method: the pull throws, which is the
    // genuine-sync-failure path this producer covers.
    await expect(
      syncConnectionToImport({
        ctx: { workspaceId: "ws-1", userId: "u-1", trpcCtx: {} },
        connectionId: "u-1:pod-1:gmail",
        model: "Message",
        connector: {} as never,
      })
    ).rejects.toThrow();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0]![0]).toMatchObject({
      type: "connector.sync.failed",
      connection: { kind: "account", id: "gmail" },
    });
  });
});
