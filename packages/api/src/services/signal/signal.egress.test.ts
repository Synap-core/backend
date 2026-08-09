/**
 * Signal outbound egress — PURE derivation gate (no DB).
 *
 * `aggregateEgressRollups` is the DB-free grouping/ordering core of `listEgress`.
 * These tests pin its two-ledger contract without a database:
 *   - `sentCount`/`lastSentAt` come from the outbound message rows;
 *   - `failedCount` folds in the outbox failure count, and may INTRODUCE a
 *     channel that has zero outbound messages (every send failed);
 *   - `problems` order floats failing channels first; `recent` orders by last send.
 */

import { describe, it, expect } from "vitest";
import { aggregateEgressRollups } from "./index.js";

const meta = new Map([
  ["c1", { name: "Client A", provider: "discord" }],
  ["c2", { name: "Client B", provider: "discord" }],
  ["c3", { name: "Client C", provider: "gmail" }],
]);

describe("aggregateEgressRollups (pure)", () => {
  it("counts outbound messages per channel and tracks the latest send", () => {
    const t1 = new Date("2026-08-01T10:00:00Z");
    const t2 = new Date("2026-08-01T12:00:00Z");
    const rollups = aggregateEgressRollups({
      outbound: [
        { channelId: "c1", ts: t1 },
        { channelId: "c1", ts: t2 },
        { channelId: "c3", ts: t1 },
      ],
      meta,
      failedByChannel: new Map(),
      order: "recent",
    });
    const byId = new Map(rollups.map((r) => [r.channelId, r]));
    expect(byId.get("c1")!.sentCount).toBe(2);
    expect(byId.get("c1")!.lastSentAt).toEqual(t2);
    expect(byId.get("c1")!.failedCount).toBe(0);
    expect(byId.get("c1")!.name).toBe("Client A");
    expect(byId.get("c1")!.provider).toBe("discord");
    expect(byId.get("c3")!.sentCount).toBe(1);
  });

  it("introduces a channel that only ever FAILED to send (no message row)", () => {
    const rollups = aggregateEgressRollups({
      outbound: [{ channelId: "c1", ts: new Date("2026-08-01T10:00:00Z") }],
      meta,
      failedByChannel: new Map([["c2", 3]]),
      order: "problems",
    });
    const c2 = rollups.find((r) => r.channelId === "c2")!;
    expect(c2).toBeTruthy();
    expect(c2.sentCount).toBe(0);
    expect(c2.failedCount).toBe(3);
    expect(c2.lastSentAt).toBeNull();
    // A failing channel floats to the front under `problems`.
    expect(rollups[0].channelId).toBe("c2");
  });

  it("a zero failure count never fabricates a failing state", () => {
    const rollups = aggregateEgressRollups({
      outbound: [{ channelId: "c1", ts: new Date("2026-08-01T10:00:00Z") }],
      meta,
      failedByChannel: new Map([["c1", 0]]),
      order: "problems",
    });
    expect(rollups).toHaveLength(1);
    expect(rollups[0].failedCount).toBe(0);
  });

  it("problems order: failing first, then highest failure count, then latest send", () => {
    const early = new Date("2026-08-01T08:00:00Z");
    const late = new Date("2026-08-01T20:00:00Z");
    const rollups = aggregateEgressRollups({
      outbound: [
        { channelId: "c1", ts: late },
        { channelId: "c2", ts: early },
        { channelId: "c3", ts: late },
      ],
      meta,
      failedByChannel: new Map([
        ["c2", 5],
        ["c3", 1],
      ]),
      order: "problems",
    });
    // c2 (5 failures) before c3 (1 failure) before c1 (0 failures, healthy).
    expect(rollups.map((r) => r.channelId)).toEqual(["c2", "c3", "c1"]);
  });

  it("recent order: newest send first, failure-only channels (null lastSentAt) last", () => {
    const early = new Date("2026-08-01T08:00:00Z");
    const late = new Date("2026-08-01T20:00:00Z");
    const rollups = aggregateEgressRollups({
      outbound: [
        { channelId: "c1", ts: early },
        { channelId: "c3", ts: late },
      ],
      meta,
      failedByChannel: new Map([["c2", 2]]),
      order: "recent",
    });
    expect(rollups.map((r) => r.channelId)).toEqual(["c3", "c1", "c2"]);
  });
});
