/**
 * The page-wire mappers. Rows are chosen where a naive mapping disagrees:
 * a non-output row handed to the card mapper (a naive cast draws it), a
 * human-produced output (a naive "outputs are AI" rule dots it), a data event
 * in Happened (a naive filter-by-class feeds it to the ledger batcher), the
 * same health issue twice (a naive map draws two banners / "+1 more").
 */
import { describe, expect, it } from "vitest";
import type { ActivityRow } from "../activity/index.js";
import { resolveUnitState } from "../units/state.js";
import {
  batchHappenedItems,
  happenedItems,
  isHappenedDataLine,
  lensBannerOfStatus,
  lensOutputOfSignal,
  lensRowOfLiveSignal,
  type LensPageSignal,
} from "./index.js";

function sig(over: Partial<LensPageSignal>): LensPageSignal {
  return {
    id: "s1",
    kind: "output",
    title: "T",
    occurredAt: "2026-10-04T10:00:00.000Z",
    target: null,
    ...over,
  };
}

const LEDGER: ActivityRow = {
  id: "proposal:p1",
  source: "proposal",
  occurredAt: "2026-10-04T10:00:00.000Z",
  actor: { kind: "agent", id: "ag1", name: "Scout" },
  action: "update",
  verb: "Updated",
  title: "Lead",
  object: { kind: "entity", id: "e1", name: "Lead" },
  proposalId: null,
  project: null,
  session: null,
  outcome: "succeeded",
  undo: null,
  error: null,
};

describe("lensOutputOfSignal", () => {
  const landed = {
    kind: "document",
    title: "Brief",
    ref: { kind: "document", id: "d1" },
    createdAt: "2026-10-04T09:00:00.000Z",
    actor: { kind: "human" },
  };
  it("maps an output's landed row: door = its ref, AI dot only for an agent", () => {
    const out = lensOutputOfSignal(
      sig({
        id: "output:x",
        landed,
        source: { kind: "session", id: "s9", label: "Run" },
      })
    );
    expect(out).toEqual({
      key: "output:x",
      objectKind: "document",
      title: "Brief",
      door: { kind: "document", id: "d1" },
      source: { kind: "session", id: "s9", label: "Run" },
      producedAt: "2026-10-04T09:00:00.000Z",
      byAgent: false,
      expected: false,
    });
    expect(
      lensOutputOfSignal(
        sig({ landed: { ...landed, actor: { kind: "agent" } } })
      )?.byAgent
    ).toBe(true);
  });
  it("refuses a row that is not an output", () => {
    expect(lensOutputOfSignal(sig({ kind: "activity", landed }))).toBeNull();
    expect(
      lensOutputOfSignal(sig({ kind: "output", landed: null }))
    ).toBeNull();
  });
});

describe("lensRowOfLiveSignal", () => {
  it("is a working Happening row, aged from the in-flight turn's start", () => {
    const row = lensRowOfLiveSignal(
      sig({
        id: "live:s1",
        kind: "live-session",
        target: { kind: "session", id: "s1" },
        live: {
          since: "2026-10-04T08:00:00.000Z",
          lastAt: "2026-10-04T09:59:00.000Z",
        },
      }),
      "Reading the brief"
    );
    expect(row.cls).toBe("happening");
    expect(resolveUnitState(row.state).state).toBe("working");
    expect(row.occurredAt).toBe("2026-10-04T08:00:00.000Z");
    expect(row.door).toEqual({ kind: "session", id: "s1" });
    expect(row.reason).toBe("Reading the brief");
  });
  it("falls back to the newest activity when no turn is in flight", () => {
    const row = lensRowOfLiveSignal(
      sig({
        kind: "live-session",
        live: { since: null, lastAt: "2026-10-04T09:59:00.000Z" },
      })
    );
    expect(row.occurredAt).toBe("2026-10-04T09:59:00.000Z");
  });
});

describe("lensBannerOfStatus — ONE banner", () => {
  it("null status (nothing wrong) is no banner", () => {
    expect(lensBannerOfStatus(null)).toBeNull();
    expect(lensBannerOfStatus({ issues: [] })).toBeNull();
  });
  it("dedupes the same condition, leads with the newest, counts the others", () => {
    const issue = {
      type: "system.intelligence_degraded",
      title: "Intelligence Hub degraded",
      occurredAt: "2026-10-04T09:00:00.000Z",
      target: null,
    };
    const banner = lensBannerOfStatus({
      issues: [
        {
          ...issue,
          title: "Hub degraded (newer)",
          occurredAt: "2026-10-04T10:00:00.000Z",
        },
        issue,
        {
          type: "pod.storage_warning",
          title: "Storage almost full",
          occurredAt: "2026-10-04T08:00:00.000Z",
          target: null,
        },
      ],
    });
    expect(banner).toEqual({
      key: "system.intelligence_degraded|",
      tone: "error",
      title: "Hub degraded (newer)",
      more: 1,
      target: null,
      action: null,
      notificationIds: [],
    });
  });
});

describe("happenedItems — work + data, one feed", () => {
  const event = (id: string, at: string, over: Partial<LensPageSignal> = {}) =>
    sig({
      id,
      kind: "event",
      title: "Entity create completed",
      occurredAt: at,
      target: { kind: "entity", id: `e-${id}` },
      event: { action: "create", objectKind: "contact", origin: "sync" },
      ...over,
    });

  it("keeps the pod's order, ledger rows and data changes interleaved", () => {
    const items = happenedItems([
      event("a", "2026-10-04T11:00:00.000Z"),
      sig({ id: "l", kind: "activity", activity: LEDGER }),
      event("b", "2026-10-04T09:00:00.000Z"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["data", "ledger", "data"]);
    expect(items[0]).toEqual({
      kind: "data",
      event: {
        id: "a",
        action: "create",
        objectKind: "contact",
        door: { kind: "entity", id: "e-a" },
        occurredAt: "2026-10-04T11:00:00.000Z",
        origin: "sync",
      },
    });
  });

  it("an event the pod could not read as a record change is not a line", () => {
    // A naive mapper would draw its humanized type ("Entity create requested").
    expect(
      happenedItems([event("x", "2026-10-04T11:00:00.000Z", { event: null })])
    ).toEqual([]);
    expect(
      happenedItems([
        event("y", "2026-10-04T11:00:00.000Z", { event: undefined }),
      ])
    ).toEqual([]);
  });

  it("batches CONSECUTIVE identical data changes — 'Sync created 3 contacts'", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    const [day] = batchHappenedItems(
      happenedItems([
        event("a", "2026-10-04T11:00:00.000Z"),
        event("b", "2026-10-04T10:59:00.000Z"),
        event("c", "2026-10-04T10:58:00.000Z"),
        // Another writer splits nothing above it but starts its own line.
        event("d", "2026-10-04T10:57:00.000Z", {
          event: { action: "create", objectKind: "contact", origin: null },
        }),
      ]),
      { timeZone: "UTC", now }
    );
    expect(day!.isToday).toBe(true);
    expect(day!.lines.map((l) => [isHappenedDataLine(l), l.count])).toEqual([
      [true, 3],
      [true, 1],
    ]);
  });

  it("a ledger act between two data changes splits the batch (never re-sorts)", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    const [day] = batchHappenedItems(
      happenedItems([
        event("a", "2026-10-04T11:00:00.000Z"),
        sig({ id: "l", kind: "activity", activity: LEDGER }),
        event("b", "2026-10-04T09:00:00.000Z"),
      ]),
      { timeZone: "UTC", now }
    );
    expect(
      day!.lines.map((l) =>
        isHappenedDataLine(l) ? `data:${l.count}` : `ledger:${l.count}`
      )
    ).toEqual(["data:1", "ledger:1", "data:1"]);
  });
});
