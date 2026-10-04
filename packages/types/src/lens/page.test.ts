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
  happenedLedgerRows,
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

describe("happenedLedgerRows", () => {
  it("keeps ledger rows in order and leaves data events out", () => {
    const rows = happenedLedgerRows([
      sig({ id: "a", kind: "activity", activity: LEDGER }),
      sig({ id: "e", kind: "event", activity: null }),
      sig({
        id: "b",
        kind: "activity",
        activity: { ...LEDGER, id: "proposal:p2" },
      }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["proposal:p1", "proposal:p2"]);
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
    });
  });
});
