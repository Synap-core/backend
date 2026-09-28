/**
 * The DRAFT row in the pure union (founder decision 2026-09-27, "draft row
 * carries its asks"): one row per undecided draft that asks something, the
 * same fold counted by `countNeedsYou`, the draft's pointer notification folded
 * into it, and the draft side paged with the owed side. Which slots ARE draft
 * slots is decided in SQL (`listOwedSlots({ onlyDrafts })`) and pinned by
 * `focus-sessions/__tests__/draft-asks.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  countNeedsYou,
  signalsFromDraftAsks,
  unionNeedsYou,
  type DraftAsksInput,
  type NotificationSignalInput,
  type OwedSlotSignalInput,
} from "../needs-you-union.js";

const DRAFT = "draft-1";
const slot = (
  sessionId: string,
  label: string,
  owedSince: string
): OwedSlotSignalInput => ({
  sessionId,
  label,
  owedSince,
  sessionGoal: "Ship billing",
  why: `why ${label}`,
  ask: { mode: "confirm" } as OwedSlotSignalInput["ask"],
});
const drafts = (slots: OwedSlotSignalInput[]): DraftAsksInput => ({
  slots,
  starterNames: new Map([[DRAFT, "Claude Code"]]),
});
const TWO_ASKS = drafts([
  slot(DRAFT, "Stripe key", "2026-09-27T10:00:00.000Z"),
  slot(DRAFT, "Pick region", "2026-09-27T09:00:00.000Z"),
]);
const base = {
  distinctClusters: 0,
  clustersTruncated: false,
  clusters: [],
  notifications: [] as NotificationSignalInput[],
  notificationsTruncated: false,
  owedSlots: [] as OwedSlotSignalInput[],
  owedTruncated: false,
  openQuestionSessionIds: new Set<string>(),
};

describe("draft-asks signal", () => {
  it("one row per draft: agent, work and the ask count; a door to the session", () => {
    const rows = signalsFromDraftAsks(TWO_ASKS);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      id: `draft:${DRAFT}`,
      kind: "draft-asks",
      title: "Claude Code started Ship billing · asks you 2 things",
      count: 2,
      target: { kind: "session", id: DRAFT },
      sessionGoal: "Ship billing",
    });
    // The NEWEST ask is the row's time — its last activity, the key the one
    // newest-first order sorts on (W2 calm; it was the oldest while owed rows
    // sorted oldest-first).
    expect(row!.occurredAt.toISOString()).toBe("2026-09-27T10:00:00.000Z");
    expect(row!.groupKey).toBe(`session:${DRAFT}`);
    expect(row!.repeatCount).toBe(1);
    // One row stands for N asks: no single ask's disclosure rides on it.
    expect(row).not.toHaveProperty("ask");
    expect(row).not.toHaveProperty("why");
  });

  it("a draft with no owed slot yields no row (nothing to fold)", () => {
    expect(signalsFromDraftAsks(drafts([]))).toEqual([]);
    // The union without the draft half is byte-identical to before.
    expect(unionNeedsYou({ ...base, draftAsks: drafts([]) })).toEqual(
      unionNeedsYou(base)
    );
  });

  it("an unnamed starter reads 'An agent', singular for one ask", () => {
    const [row] = signalsFromDraftAsks({
      slots: [slot("other", "Stripe key", "2026-09-27T10:00:00.000Z")],
      starterNames: new Map(),
    });
    expect(row!.title).toBe("An agent started Ship billing · asks you 1 thing");
  });

  it("list and count agree: the draft counts ONCE, as `drafts`, never in `blocked`", () => {
    const listed = unionNeedsYou({ ...base, draftAsks: TWO_ASKS });
    expect(listed.map((s) => s.kind)).toEqual(["draft-asks"]);
    const counted = countNeedsYou({ ...base, draftAsks: TWO_ASKS });
    expect(counted.drafts).toBe(1);
    expect(counted.blocked).toBe(0);
    expect(counted.needsYou).toBe(listed.length);
    expect(counted.needsYou).toBe(
      counted.decisions +
        counted.notifications +
        counted.blocked +
        counted.review +
        counted.drafts
    );
  });

  it("the draft's session.needs_you pointer folds into the draft row", () => {
    const pointer: NotificationSignalInput = {
      id: "n1",
      type: "session.needs_you",
      title: "Claude Code needs you",
      category: "ai",
      sourceType: "session",
      sourceId: DRAFT,
      createdAt: new Date("2026-09-27T11:00:00Z"),
    };
    // The draft's room also holds an open question, so the pointer would
    // survive on that ground alone — only the fold removes it.
    const args = {
      ...base,
      notifications: [pointer],
      openQuestionSessionIds: new Set([DRAFT]),
      draftAsks: TWO_ASKS,
    };
    expect(unionNeedsYou(args).map((s) => s.kind)).toEqual(["draft-asks"]);
    expect(countNeedsYou(args).needsYou).toBe(1);
  });

  it("sorts with every other row by recency — its newest ask outranks an older slot", () => {
    const owed = slot("s-2", "Sign contract", "2026-09-27T08:00:00.000Z");
    const all = unionNeedsYou({
      ...base,
      owedSlots: [owed],
      draftAsks: TWO_ASKS,
      now: new Date("2026-09-28T00:00:00.000Z"),
    });
    expect(all.map((s) => s.kind)).toEqual(["draft-asks", "owed-slot"]);
  });

  it("truncation of the draft scan makes the count a floor", () => {
    expect(
      countNeedsYou({ ...base, draftAsks: TWO_ASKS, draftAsksTruncated: true })
        .truncated
    ).toBe(true);
  });
});
