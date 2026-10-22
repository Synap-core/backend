/**
 * The Inbox's four filters (`needsYouBuckets`). Each fixture row names the
 * WRONG rule it rules out — a row two candidate rules agree on is decoration
 * (guards-and-tests.md: coverage is the set of inputs where the rules
 * disagree).
 */
import { describe, expect, it } from "vitest";
import type { ProposalIntentInput } from "../proposals/intent.js";
import {
  NEEDS_YOU_REASON_ICONS,
  BLOCKED_REASON_ICONS,
  BLOCKED_REASON_FALLBACK_ICON,
  NEEDS_YOU_BUCKET_LABELS,
  resolveNeedsYouReasonIcon,
  resolveNeedsYouReasonLabel,
  resolveNeedsYouItemCount,
} from "../vocabulary/index.js";
import {
  NEEDS_YOU_BUCKETS,
  needsYouBucketOf,
  needsYouBuckets,
  needsYouReasonOf,
  needsYouRows,
  orderNeedsYouSignals,
  type BucketableSignal,
  type NeedsYouBucket,
} from "./index.js";
import { lensRowOfNeedsYou, type LensNeedsYouSignal } from "../lens/index.js";

type Row = BucketableSignal & { intent?: ProposalIntentInput | null };

const SAFE: ProposalIntentInput = {
  kind: "update",
  revertable: true,
};

function proposal(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    kind: "proposal-cluster",
    count: 1,
    target: { kind: "proposal", id: `p-${id}` },
    intent: SAFE,
    ...extra,
  };
}

const intentOf = (s: Row) => s.intent;

/** [row, expected bucket, the wrong rule this row rules out]. */
const TABLE: Array<[Row, NeedsYouBucket, string]> = [
  [proposal("safe"), "routine", "every pending proposal is a decision"],
  [
    proposal("cluster", { count: 3 }),
    "decision",
    "routine = swipe-safe, whatever the cluster size (×N batches N on one sample id)",
  ],
  // A cluster whose count is not a number (an untyped wire row, an older
  // pod) is NOT a single: it fails closed to a decision (review R1 #7).
  [
    proposal("count-nan", { count: Number.NaN }),
    "decision",
    "a non-finite count reads as single (fails open into batch-approve)",
  ],
  [
    proposal("count-missing", { count: undefined as unknown as number }),
    "decision",
    "a missing count reads as single",
  ],
  [
    proposal("count-null", { count: null as unknown as number }),
    "decision",
    "a null count reads as single",
  ],
  [
    proposal("no-intent", { intent: undefined }),
    "decision",
    "an unloaded proposal defaults to routine",
  ],
  [
    proposal("unmeasured", { intent: { kind: "update", revertable: null } }),
    "decision",
    "revertability unmeasured reads as reversible",
  ],
  [
    proposal("remove", {
      intent: { kind: "update", changeType: "archive", revertable: true },
    }),
    "decision",
    "a reversible removal is routine (impact is high)",
  ],
  [
    proposal("not-a-proposal-target", {
      target: { kind: "session", id: "s1" },
    }),
    "decision",
    "routine when the intent is safe, even with no ONE proposal to approve",
  ],
  [
    {
      id: "owed-with-safe-intent",
      kind: "owed-slot",
      count: 1,
      blockedReason: "credential",
      intent: SAFE,
    },
    "question",
    "routine = intentOf says safe, whatever the row kind",
  ],
  [
    {
      id: "owed-decision",
      kind: "owed-slot",
      count: 1,
      blockedReason: "Decision",
    },
    "decision",
    "an owed slot is always a question",
  ],
  [
    { id: "access", kind: "access-request", count: 1 },
    "decision",
    "only proposals are decisions",
  ],
  [
    { id: "review", kind: "session-review", count: 1 },
    "question",
    "bucket by the lens state (a review wears pendingDecisions)",
  ],
  [
    {
      id: "failed-run",
      kind: "notification",
      count: 1,
      notificationType: "agent.task_failed",
    },
    "broken",
    "a notification is always a question",
  ],
  [
    {
      id: "broken-automation",
      kind: "notification",
      count: 1,
      notificationType: "automation.broken",
    },
    "broken",
    "broken = agent failures only",
  ],
  [
    {
      id: "health",
      kind: "notification",
      count: 1,
      notificationType: "pod.storage_warning",
    },
    "question",
    "broken = any system notification (health is the banner)",
  ],
  [
    { id: "capture", kind: "capture", count: 1 },
    "question",
    "a capture's filing choice is a decision",
  ],
  [
    { id: "future-kind", kind: "something-new", count: 1 },
    "question",
    "an unknown kind is dropped or batched",
  ],
];

describe("needsYouBucketOf — one bucket per row", () => {
  for (const [row, expected, rules_out] of TABLE) {
    it(`${row.id} → ${expected} (rules out: ${rules_out})`, () => {
      expect(needsYouBucketOf(row, { intentOf })).toBe(expected);
    });
  }

  it("with no intent lookup at all, nothing is routine (fails closed)", () => {
    expect(needsYouBucketOf(proposal("safe"))).toBe("decision");
  });

  it("NON-VACUITY: the table reaches every bucket", () => {
    const reached = new Set(TABLE.map(([, b]) => b));
    expect([...reached].sort()).toEqual([...NEEDS_YOU_BUCKETS].sort());
  });
});

describe("needsYouBuckets — a partition, ordered by what blocks the most", () => {
  it("counts add up to the list: every row is filed exactly once", () => {
    const rows = TABLE.map(([r]) => r);
    const { rows: filed, counts } = needsYouBuckets(rows, { intentOf });
    expect(filed).toHaveLength(rows.length);
    expect(new Set(filed.map((r) => r.signal.id)).size).toBe(rows.length);
    const sum = NEEDS_YOU_BUCKETS.reduce((n, b) => n + counts[b], 0);
    expect(sum).toBe(rows.length);
    expect(counts).toEqual({
      decision: 10,
      question: 5,
      routine: 1,
      broken: 2,
    });
  });

  it("decision, question, broken, then routine — whatever the server order", () => {
    // Server order is newest first: the routine change and the failure are the
    // NEWEST, so a rule that keeps server order would lead with them.
    const page: Row[] = [
      proposal("routine-1"),
      {
        id: "fail",
        kind: "notification",
        count: 1,
        notificationType: "agent.task_failed",
      },
      { id: "ask", kind: "owed-slot", count: 1, blockedReason: "credential" },
      { id: "decide", kind: "access-request", count: 1 },
    ];
    const { rows } = needsYouBuckets(page, { intentOf });
    expect(rows.map((r) => r.signal.id)).toEqual([
      "decide",
      "ask",
      "fail",
      "routine-1",
    ]);
  });

  it("inside a bucket, a row that stops a session's work leads; then server order", () => {
    const page: Row[] = [
      proposal("free-newest", { count: 2 }),
      proposal("free-older", { count: 2 }),
      proposal("in-session", { count: 2, groupKey: "session:s1" }),
      proposal("free-oldest", { count: 2 }),
    ];
    const { rows } = needsYouBuckets(page, { intentOf });
    expect(rows.map((r) => r.signal.id)).toEqual([
      "in-session",
      "free-newest",
      "free-older",
      "free-oldest",
    ]);
  });

  it("does not mutate the page it was handed", () => {
    const page: Row[] = [
      proposal("a"),
      { id: "b", kind: "access-request", count: 1 },
    ];
    const before = page.map((r) => r.id);
    needsYouBuckets(page, { intentOf });
    expect(page.map((r) => r.id)).toEqual(before);
  });
});

describe("orderNeedsYouSignals — the Inbox order, before grouping", () => {
  it("a session's card lands at its most blocking item; then the rest by the rule", () => {
    const page = [
      // Server order: newest first — a free question leads.
      {
        id: "q-free",
        kind: "owed-slot",
        count: 1,
        blockedReason: "credential",
        groupKey: null,
        ageBucket: "recent" as const,
        repeatCount: 1,
      },
      {
        id: "q-s1",
        kind: "owed-slot",
        count: 1,
        blockedReason: "credential",
        groupKey: "session:s1",
        ageBucket: "recent" as const,
        repeatCount: 1,
      },
      {
        id: "d-s1",
        kind: "access-request",
        count: 1,
        groupKey: "session:s1",
        ageBucket: "recent" as const,
        repeatCount: 1,
      },
    ];
    const ordered = orderNeedsYouSignals(page);
    expect(ordered.map((s) => s.id)).toEqual(["d-s1", "q-s1", "q-free"]);
    // Grouped: the session card first (it holds the decision), the free ask after.
    const rows = needsYouRows(ordered).recent;
    expect(rows.map((r) => r.key)).toEqual(["session:s1", "q-free"]);
    // Rules out "group, then keep server order": that leads with the free ask.
    expect(needsYouRows(page).recent[0]!.key).toBe("q-free");
  });
});

describe("the reason glyph", () => {
  const REASONS: Array<[Row, string]> = [
    [proposal("p"), "decision"],
    [{ id: "a", kind: "access-request", count: 1 }, "decision"],
    [{ id: "i", kind: "space-invite", count: 1 }, "decision"],
    [
      { id: "o", kind: "owed-slot", count: 1, blockedReason: "Credential" },
      "credential",
    ],
    [{ id: "o2", kind: "owed-slot", count: 1 }, "owed"],
    [{ id: "r", kind: "session-review", count: 1 }, "review"],
    [{ id: "c", kind: "capture", count: 1 }, "ask"],
    [
      { id: "n", kind: "notification", count: 1, notificationType: "x.y" },
      "ask",
    ],
    [
      {
        id: "f",
        kind: "notification",
        count: 1,
        notificationType: "automation.broken",
      },
      "failure",
    ],
  ];

  for (const [row, reason] of REASONS) {
    it(`${row.id} → ${reason}, drawn with an explicit glyph and a label`, () => {
      expect(needsYouReasonOf(row)).toBe(reason);
      expect(resolveNeedsYouReasonIcon(reason)).not.toBe(
        BLOCKED_REASON_FALLBACK_ICON
      );
      expect(resolveNeedsYouReasonLabel(reason)).not.toBe("");
    });
  }

  it("keeps every blocker's own glyph (an owed slot reads as its obstacle)", () => {
    for (const [k, v] of Object.entries(BLOCKED_REASON_ICONS)) {
      expect(NEEDS_YOU_REASON_ICONS[k]).toBe(v);
    }
    expect(resolveNeedsYouReasonIcon("not-a-reason")).toBe(
      BLOCKED_REASON_FALLBACK_ICON
    );
  });

  it("reaches the lens row the Inbox draws (reasonKind on lensRowOfNeedsYou)", () => {
    const signal: LensNeedsYouSignal = {
      id: "f",
      kind: "notification",
      title: "Nightly import failed",
      count: 1,
      groupKey: null,
      ageBucket: "recent",
      repeatCount: 1,
      notificationType: "agent.task_failed",
    };
    const row = lensRowOfNeedsYou(
      { kind: "item", key: signal.id, signal, session: null },
      "blocking"
    );
    expect(row.reasonKind).toBe("failure");
  });

  it('counts a routine batch in its own noun (never "2 routines")', () => {
    expect(resolveNeedsYouItemCount("routine", 1)).toBe("1 routine change");
    expect(resolveNeedsYouItemCount("routine", 14)).toBe("14 routine changes");
  });

  it("names every filter", () => {
    for (const b of NEEDS_YOU_BUCKETS) {
      expect(NEEDS_YOU_BUCKET_LABELS[b]).toMatch(/^[A-Z]/);
    }
  });
});
