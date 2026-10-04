/**
 * THE lens page model. Every fixture is an input where the two retired
 * mappers (browser `homeLensModel`, relay `lensBodyView`) DISAGREED, so each
 * row rules one of them out:
 *   - a Happened data `event`   — relay dropped it (ledger-only batcher);
 *   - a partly failed Blocking  — web said FAILED (hid the rows), relay drew
 *                                 an exact count (the total misses the half);
 *   - a session card of 3 units — relay's "Show all" counted rows, web units;
 *   - a batch of 3 acts today   — web counted acts, relay lines;
 *   - a Proposed notification   — web offered no dismiss, relay no draft discard;
 *   - a data change newest      — web took the raw first row, relay today's first ledger line.
 */
import { describe, expect, it } from "vitest";
import { activityActorName, type ActivityRow } from "../activity/index.js";
import { resolveUnitState } from "../units/state.js";
import {
  LENS_CAPS,
  isHappenedDataLine,
  lensLastActivityAt,
  lensPageCounts,
  lensPageModel,
  type LensNeedsYouSignal,
  type LensPage,
  type LensPageClass,
  type LensPageSignal,
} from "./index.js";

type Sig = LensPageSignal & LensNeedsYouSignal;
const TZ = "UTC";
const NOW = new Date("2026-10-04T12:00:00.000Z");

function sig(id: string, over: Partial<Sig> = {}): Sig {
  return {
    id,
    kind: "owed-slot",
    title: `T ${id}`,
    occurredAt: "2026-10-04T10:00:00.000Z",
    target: { kind: "session", id: "s-" + id },
    count: 1,
    groupKey: null,
    ageBucket: "recent",
    repeatCount: 1,
    ...over,
  };
}

function cls(rows: Sig[], over: Partial<LensPageClass<Sig>> = {}): LensPageClass<Sig> {
  return { rows, total: rows.length, truncated: false, hasMore: false, unreadable: [], ...over };
}

function page(over: Partial<LensPage<Sig>> = {}): LensPage<Sig> {
  return {
    blocking: cls([]),
    proposed: cls([]),
    happening: cls([]),
    produced: cls([]),
    happened: cls([]),
    status: null,
    statusUnreadable: false,
    ...over,
  };
}

function ledger(id: string, at: string, over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id,
    source: "proposal",
    occurredAt: at,
    actor: { kind: "agent", id: "ag1", name: "Scout" },
    action: "update",
    verb: "Updated",
    title: "Lead",
    object: { kind: "task", id: "o-" + id, name: "Lead" },
    proposalId: null,
    project: null,
    session: null,
    outcome: "succeeded",
    undo: null,
    error: null,
    ...over,
  };
}

const model = (p: LensPage<Sig>) => lensPageModel(p, { timeZone: TZ, now: NOW });

describe("Happened — work AND data, counted in acts", () => {
  it("draws a data event as a data line (the ledger-only batcher dropped it)", () => {
    const m = model(
      page({
        happened: cls([
          sig("event:1", {
            kind: "event",
            occurredAt: "2026-10-04T11:00:00.000Z",
            event: { action: "create", objectKind: "contact", origin: "sync" },
            target: { kind: "entity", id: "c1" },
          }),
        ]),
      })
    );
    expect(m.happened.items).toHaveLength(1);
    expect(isHappenedDataLine(m.happened.items[0]!)).toBe(true);
    expect(m.happened.count).toBe(1);
  });

  it("counts ACTS, not lines: a batch of 3 is 3", () => {
    const rows = [1, 2, 3].map((i) =>
      sig(`a${i}`, { kind: "activity", activity: ledger(`l${i}`, `2026-10-04T1${i}:00:00.000Z`) })
    );
    const m = model(page({ happened: cls(rows) }));
    expect(m.happened.items).toHaveLength(1);
    expect(m.happened.count).toBe(3);
    // Nothing left out: the one line IS the 3 acts.
    expect(m.happened.showAll).toBeNull();
  });

  it("Show all N is acts, and a cut read makes the number a floor", () => {
    const rows = Array.from({ length: LENS_CAPS.happened + 1 }, (_, i) =>
      sig(`a${i}`, {
        kind: "activity",
        activity: ledger(`l${i}`, "2026-10-04T10:00:00.000Z", { action: i % 2 ? "create" : "update" }),
      })
    );
    const m = model(page({ happened: cls(rows, { hasMore: true }) }));
    expect(m.happened.items).toHaveLength(LENS_CAPS.happened);
    expect(m.happened.rest).toHaveLength(1);
    expect(m.happened.showAll).toBe(LENS_CAPS.happened + 1);
    expect(m.happened.floor).toBe(true);
  });

  it("last activity is the newest item — a data change included", () => {
    const p = page({
        happened: cls([
          sig("event:9", {
            kind: "event",
            occurredAt: "2026-10-04T11:30:00.000Z",
            event: { action: "update", objectKind: "contact", origin: null },
          }),
          sig("a1", { kind: "activity", activity: ledger("l1", "2026-10-04T11:00:00.000Z") }),
        ]),
      });
    const m = model(p);
    expect(m.lastActivityAt).toBe("2026-10-04T11:30:00.000Z");
    expect(lensLastActivityAt(p.happened)).toBe(m.lastActivityAt);
  });
});

describe("partial reads — rows drawn, retry, never an exact count", () => {
  const partial = page({
    blocking: cls([sig("p1"), sig("p2")], { total: 2, unreadable: ["notifications"] }),
  });
  it("a partly failed class is PARTIAL: rows kept, count unknown, no Show all", () => {
    const m = model(partial);
    expect(m.blocking.status).toBe("partial");
    expect(m.blocking.items).toHaveLength(2);
    expect(m.blocking.count).toBeNull();
    expect(m.blocking.showAll).toBeNull();
  });
  it("the header count is unknown too (never 'All clear', never the partial total)", () => {
    expect(model(partial).counts.blocking).toBeNull();
    expect(lensPageCounts(partial).blocking).toBeNull();
  });
  it("a failed half with nothing to draw is FAILED", () => {
    const m = model(page({ happening: cls([], { unreadable: ["liveness"] }) }));
    expect(m.happening.status).toBe("failed");
    expect(m.happening.count).toBeNull();
  });
});

describe("Show all counts the class's UNITS", () => {
  it("a session card counts its items; rows are capped, never split", () => {
    const card = [1, 2, 3].map((i) =>
      sig(`c${i}`, { groupKey: "session:S", sessionId: "S", target: { kind: "session", id: "S" } } as Partial<Sig>)
    );
    const singles = [1, 2, 3, 4, 5].map((i) => sig(`x${i}`));
    const m = model(page({ blocking: cls([...card, ...singles]) }));
    // 6 rows: the card + 5 singles; 5 shown, 1 single left out.
    expect(m.blocking.items).toHaveLength(LENS_CAPS.blocking);
    expect(m.blocking.items[0]!.row.count).toBe(3);
    expect(m.blocking.rest).toHaveLength(1);
    // "Show all N" is the needs-you number (8 signals), not 6 rows.
    expect(m.blocking.showAll).toBe(8);
    expect(m.blocking.count).toBe(8);
  });
  it("a card's items count as shown: 5 rows standing for 7 signals leave nothing out", () => {
    const card = [1, 2, 3].map((i) =>
      sig(`c${i}`, { groupKey: "session:S", sessionId: "S", target: { kind: "session", id: "S" } } as Partial<Sig>)
    );
    const m = model(page({ blocking: cls([...card, ...[1, 2, 3, 4].map((i) => sig(`x${i}`))]) }));
    expect(m.blocking.count).toBe(7);
    expect(m.blocking.rest).toHaveLength(0);
    expect(m.blocking.showAll).toBeNull();
  });
});

describe("dismiss — every Proposed row, never a Blocking one", () => {
  const draft = sig("d1", { kind: "draft-asks", count: 2, target: { kind: "session", id: "sd" } });
  const suggestion = sig("notification:n1", { kind: "notification", target: { kind: "entity", id: "e1" } });
  const m = model(
    page({
      proposed: cls([draft, suggestion]),
      blocking: cls([sig("notification:n2", { kind: "notification" })]),
    })
  );
  it("a draft is discarded, a suggestion dismissed", () => {
    expect(m.proposed.items.map((i) => i.dismiss)).toEqual([
      [{ action: "discard-draft", signalId: "d1", door: { kind: "session", id: "sd" } }],
      [{ action: "dismiss-suggestion", signalId: "notification:n1", door: { kind: "entity", id: "e1" } }],
    ]);
  });
  it("a Blocking notification is not dismissible", () => {
    expect(m.blocking.items[0]!.dismiss).toBeNull();
  });
  it("a suggestion wears the quiet 'offered' mark and earns no verb", () => {
    const row = m.proposed.items[1]!.row;
    expect(resolveUnitState(row.state).state).toBe("not_started");
    expect(row.verb).toBeNull();
  });
});

describe("the header counts ARE the section counts (non-empty page)", () => {
  it("blocking / happening / produced doors equal their sections", () => {
    const landed = (id: string) => ({
      kind: "document",
      title: id,
      ref: { kind: "document", id },
      createdAt: "2026-10-04T09:00:00.000Z",
    });
    const m = model(
      page({
        blocking: cls([sig("b1"), sig("b2"), sig("b3")], { total: 7, hasMore: true }),
        happening: cls([sig("live:1", { kind: "live-session" })], { total: 4, hasMore: true }),
        produced: cls(
          [sig("output:1", { kind: "output", landed: landed("d1") }), sig("output:2", { kind: "output", landed: landed("d2") })],
          { total: 12, hasMore: true }
        ),
      })
    );
    expect(m.counts).toEqual({
      blocking: m.blocking.count,
      happening: m.happening.count,
      produced: m.produced.count,
    });
    expect(m.counts).toEqual({ blocking: 7, happening: 4, produced: 12 });
    expect(lensPageCounts(page({
      blocking: cls([], { total: 7 }),
      happening: cls([], { total: 4 }),
      produced: cls([], { total: 12 }),
    }))).toEqual(m.counts);
    expect(m.produced.showAll).toBe(12);
  });
});

describe("activityActorName — one spelling", () => {
  it("names the viewer You, an unnamed agent by its noun", () => {
    expect(activityActorName({ kind: "human", id: "u", name: "Ann", isViewer: true })).toBe("You");
    expect(activityActorName({ kind: "agent", id: null, name: null })).toBe("Agent");
  });
});
