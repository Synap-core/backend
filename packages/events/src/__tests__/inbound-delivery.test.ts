/**
 * The delivery of a stored inbound webhook (pipeline-health W1): the
 * `external_webhook.received` fan-out is built FROM the stored row; what did
 * not reach the queue is settled incomplete (owed, for the sweeper) and the
 * retry skips the reactors already delivered; a space-less source fires
 * nothing and says why.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  settled: [] as any[],
  fanned: [] as any[],
  /** Reactor ids that fail on their next call (then succeed). */
  failOnce: new Set<string>(),
  queueDown: false,
}));
vi.mock("@synap/database", () => ({
  db: {},
  claimInboundDelivery: async (_db: unknown, id: string) =>
    h.rows.get(id) ?? null,
  settleInboundDelivery: async (_db: unknown, id: string, r: any) => {
    h.settled.push({ id, ...r });
    const row = h.rows.get(id);
    if (row) row.delivered = r.delivered;
  },
  listDueInboundDeliveries: async () => [...h.rows.keys()],
  pruneInboundDeliveries: async () => 0,
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock("../side-effects.js", () => ({
  fanOutSideEffects: async (p: any, skip: ReadonlySet<string>) => {
    if (h.queueDown) return { delivered: [], failed: [], queueDown: true };
    const delivered: string[] = [];
    const failed: string[] = [];
    for (const id of ["automation-trigger-match", "webhook-delivery"]) {
      if (skip.has(id)) continue;
      if (h.failOnce.delete(id)) {
        failed.push(id);
        continue;
      }
      h.fanned.push({ reactor: id, payload: p });
      delivered.push(id);
    }
    return { delivered, failed, queueDown: false };
  },
}));

import {
  dispatchInboundDelivery,
  dispatchDueInboundDeliveries,
  INBOUND_NO_WORKSPACE,
} from "../inbound-delivery.js";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    subscriptionId: "sub-1",
    userId: "owner-1",
    workspaceId: "ws-1",
    deliveryId: "gh-1",
    event: "pull_request",
    payload: { action: "closed", number: 7 },
    delivered: [] as string[],
    attempts: 1,
    ...over,
  };
}

beforeEach(() => {
  h.rows.clear();
  h.settled.length = 0;
  h.fanned.length = 0;
  h.failOnce.clear();
  h.queueDown = false;
});

describe("dispatchInboundDelivery", () => {
  it("fans out the event FROM the stored row and settles it complete", async () => {
    h.rows.set("row-1", row());
    expect(await dispatchInboundDelivery("row-1")).toBe(true);

    const trigger = h.fanned.find(
      (f) => f.reactor === "automation-trigger-match"
    );
    expect(trigger.payload).toEqual({
      subjectType: "external_webhook",
      action: "received",
      subjectId: "sub-1",
      userId: "owner-1",
      workspaceId: "ws-1",
      data: {
        subscriptionId: "sub-1",
        payload: { action: "closed", number: 7 },
        event: "pull_request",
        deliveryId: "gh-1",
        inboundDeliveryId: "row-1",
      },
    });
    expect(h.settled).toEqual([
      {
        id: "row-1",
        delivered: ["automation-trigger-match", "webhook-delivery"],
        complete: true,
        error: null,
      },
    ]);
  });

  it("leaves event + deliveryId absent when the sender sent none", async () => {
    h.rows.set("row-1", row({ deliveryId: null, event: null }));
    await dispatchInboundDelivery("row-1");
    const data = h.fanned[0].payload.data;
    expect(data).not.toHaveProperty("event");
    expect(data).not.toHaveProperty("deliveryId");
  });

  it("a reactor that fails leaves the row owed; the retry sends ONLY what is still owed", async () => {
    h.rows.set("row-1", row());
    h.failOnce.add("automation-trigger-match");

    expect(await dispatchInboundDelivery("row-1")).toBe(false);
    expect(h.settled[0]).toMatchObject({
      complete: false,
      delivered: ["webhook-delivery"],
      error: "automation-trigger-match",
    });

    const before = h.fanned.length;
    expect(await dispatchInboundDelivery("row-1")).toBe(true);
    const retried = h.fanned.slice(before).map((f) => f.reactor);
    expect(retried).toEqual(["automation-trigger-match"]);
    expect(h.settled[1]).toMatchObject({
      complete: true,
      delivered: ["webhook-delivery", "automation-trigger-match"],
    });
  });

  it("a queue that is down leaves the row owed, with the reason", async () => {
    h.rows.set("row-1", row());
    h.queueDown = true;
    expect(await dispatchInboundDelivery("row-1")).toBe(false);
    expect(h.settled[0]).toMatchObject({
      complete: false,
      error: "queue unavailable",
    });
  });

  it("a source with no space fires nothing and is settled with the reason", async () => {
    h.rows.set("row-1", row({ workspaceId: null }));
    expect(await dispatchInboundDelivery("row-1")).toBe(true);
    expect(h.fanned).toHaveLength(0);
    expect(h.settled[0]).toMatchObject({
      complete: true,
      error: INBOUND_NO_WORKSPACE,
    });
  });

  it("a row it cannot claim (done, or held) is left alone", async () => {
    expect(await dispatchInboundDelivery("row-missing")).toBe(false);
    expect(h.fanned).toHaveLength(0);
    expect(h.settled).toHaveLength(0);
  });

  it("the sweeper delivers every due row", async () => {
    h.rows.set("row-1", row());
    h.rows.set("row-2", row({ id: "row-2", deliveryId: "gh-2" }));
    const r = await dispatchDueInboundDeliveries();
    expect(r).toEqual({ due: 2, delivered: 2, pruned: 0 });
  });
});
