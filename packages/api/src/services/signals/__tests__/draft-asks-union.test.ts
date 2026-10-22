/**
 * The DRAFT row in the pure union (founder decision 2026-09-27, "draft row
 * carries its asks"): one row per undecided draft that asks something, the
 * same fold counted by `countNeedsYou`, the draft's pointer notification folded
 * into it. Since the lens grammar (founder-approved 2026-10-04: "AI
 * suggestions + agent drafts = Proposed") the row is PROPOSED — emitted by
 * `unionProposed`, never by `unionNeedsYou`, and never a part of `needsYou`. Which slots ARE draft
 * slots is decided in SQL (`listOwedSlots({ onlyDrafts })`) and pinned by
 * `focus-sessions/__tests__/draft-asks.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  countNeedsYou,
  signalsFromDraftAsks,
  unionNeedsYou,
  unionProposed,
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
  it("one row per draft: the agent and the work, NO ask count; a door to the session", () => {
    const rows = signalsFromDraftAsks(TWO_ASKS);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      id: `draft:${DRAFT}`,
      kind: "draft-asks",
      // Since 2026-10-22 the asks are Needs-you rows of their own; the draft
      // row is the draft (count 1), never a second tally of them.
      title: "Claude Code started Ship billing",
      count: 1,
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

  it("an unnamed starter reads 'An agent'", () => {
    const [row] = signalsFromDraftAsks({
      slots: [slot("other", "Stripe key", "2026-09-27T10:00:00.000Z")],
      starterNames: new Map(),
    });
    expect(row!.title).toBe("An agent started Ship billing");
  });

  it("PROPOSED, not Blocking: listed by unionProposed, absent from needs-you, counted only as `drafts`", () => {
    // Discriminating fixture: the SAME draft input, read by both unions.
    expect(unionNeedsYou({ ...base, draftAsks: TWO_ASKS })).toEqual([]);
    expect(
      unionProposed({ draftAsks: TWO_ASKS, notifications: [] }).map(
        (s) => s.kind
      )
    ).toEqual(["draft-asks"]);
    const counted = countNeedsYou({ ...base, draftAsks: TWO_ASKS });
    expect(counted.drafts).toBe(1);
    expect(counted.blocked).toBe(0);
    expect(counted.needsYou).toBe(0);
    expect(counted.needsYou).toBe(
      counted.decisions +
        counted.notifications +
        counted.blocked +
        counted.review
    );
  });

  it("the draft's session.needs_you pointer folds into the draft — it never resurfaces in needs-you", () => {
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
    expect(unionNeedsYou(args)).toEqual([]);
    expect(countNeedsYou(args).needsYou).toBe(0);
    // Without the draft the same pointer IS a needs-you row (control).
    expect(unionNeedsYou({ ...args, draftAsks: undefined })).toHaveLength(1);
  });

  it("Proposed sorts drafts and suggestions newest first", () => {
    const suggestion: NotificationSignalInput = {
      id: "s1",
      type: "ai.proactive.nudge",
      title: "Try this",
      category: "ai",
      sourceType: "ai_proactive",
      sourceId: null,
      createdAt: new Date("2026-09-27T09:30:00Z"),
    };
    expect(
      unionProposed({ draftAsks: TWO_ASKS, notifications: [suggestion] }).map(
        (s) => s.kind
      )
    ).toEqual(["draft-asks", "notification"]);
  });

  it("truncation of the draft scan makes `drafts` a floor, never the needs-you number", () => {
    const c = countNeedsYou({
      ...base,
      draftAsks: TWO_ASKS,
      draftAsksTruncated: true,
    });
    expect(c.draftsTruncated).toBe(true);
    expect(c.truncated).toBe(false);
  });
});

/**
 * FOUNDER DECISION 2026-10-22: a draft's ASKS count in Needs you (they reach
 * `owedSlots` through `listNeedsYouOwed`), and the draft stays ONE Proposed
 * row. One number, one source: the asks are counted once, in `blocked`, and
 * the draft once, in `drafts` — never the asks twice.
 */
describe("a draft's asks in Needs you, counted once", () => {
  it("the same two asks: two needs-you rows, one Proposed row, blocked = 2, drafts = 1", () => {
    const args = { ...base, owedSlots: TWO_ASKS.slots, draftAsks: TWO_ASKS };
    const needsYou = unionNeedsYou(args);
    expect(needsYou.filter((r) => r.kind === "owed-slot")).toHaveLength(2);
    expect(needsYou.some((r) => r.kind === "draft-asks")).toBe(false);
    const proposed = unionProposed({ draftAsks: TWO_ASKS, notifications: [] });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ kind: "draft-asks", count: 1 });
    const c = countNeedsYou(args);
    expect(c.blocked).toBe(2);
    expect(c.drafts).toBe(1);
    expect(c.needsYou).toBe(2);
  });
});
