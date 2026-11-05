/**
 * THE needs-you priority (`./priority.ts`): derived from the rule's class and
 * the ask's `answerBy`; the asker's `urgency` only ever lowers it.
 */
import { describe, expect, it } from "vitest";
import {
  NEEDS_YOU_CLASS_PRIORITY,
  NEEDS_YOU_PRIORITIES,
  NEEDS_YOU_PRIORITY_NOTIFICATION_LEVEL,
  loudestNeedsYouPriority,
  needsYouPriority,
} from "./priority.js";
import { orderNeedsYouSignals, type BucketableSignal } from "./buckets.js";
import type { NeedsYouClass } from "./rule.js";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const inMinutes = (m: number) =>
  new Date(NOW.getTime() + m * 60_000).toISOString();

describe("needsYouPriority", () => {
  it("a headline ask with no deadline is P1 (push), whatever urgency it claims above that", () => {
    expect(needsYouPriority({ needsYouClass: "needs_you" }, NOW)).toBe("P1");
    expect(
      needsYouPriority({ needsYouClass: "needs_you", urgency: "asap" }, NOW)
    ).toBe("P1");
    expect(
      needsYouPriority({ needsYouClass: "needs_you", urgency: "today" }, NOW)
    ).toBe("P1");
  });

  it("a headline ask due within the hour, or overdue, is P0", () => {
    for (const m of [59, 60, 0, -30]) {
      expect(
        needsYouPriority(
          { needsYouClass: "needs_you", answerBy: inMinutes(m) },
          NOW
        )
      ).toBe("P0");
    }
  });

  it("due later than the hour stays P1; an unreadable answerBy is ignored", () => {
    expect(
      needsYouPriority(
        { needsYouClass: "needs_you", answerBy: inMinutes(61) },
        NOW
      )
    ).toBe("P1");
    for (const bad of ["tomorrow", 12, null, ""]) {
      expect(
        needsYouPriority({ needsYouClass: "needs_you", answerBy: bad }, NOW)
      ).toBe("P1");
    }
  });

  it("urgency 'whenever' only LOWERS: a headline ask (even due now) is held at P2", () => {
    expect(
      needsYouPriority({ needsYouClass: "needs_you", urgency: "whenever" }, NOW)
    ).toBe("P2");
    expect(
      needsYouPriority(
        {
          needsYouClass: "needs_you",
          urgency: "whenever",
          answerBy: inMinutes(5),
        },
        NOW
      )
    ).toBe("P2");
    // …and never raises a digest row.
    expect(
      needsYouPriority(
        { needsYouClass: "review_later", urgency: "whenever" },
        NOW
      )
    ).toBe("P3");
  });

  it("a fold never breaks through: a deadline cannot lift a row the rule kept out of the headline", () => {
    const folds: NeedsYouClass[] = [
      "working",
      "changes_to_review",
      "stopped",
      "review_later",
      "from_system",
    ];
    for (const c of folds) {
      expect(
        needsYouPriority(
          { needsYouClass: c, answerBy: inMinutes(1), urgency: "today" },
          NOW
        )
      ).toBe(NEEDS_YOU_CLASS_PRIORITY[c]);
    }
    expect(needsYouPriority({ needsYouClass: "working" }, NOW)).toBe("P2");
    expect(needsYouPriority({ needsYouClass: "from_system" }, NOW)).toBe("P3");
  });

  it("every class has a level, and the levels are the closed four", () => {
    for (const p of Object.values(NEEDS_YOU_CLASS_PRIORITY)) {
      expect(NEEDS_YOU_PRIORITIES).toContain(p);
    }
  });
});

describe("the priority ranks inside the ONE triage order (orderNeedsYouByBlocking)", () => {
  const row = (
    id: string,
    extra: Record<string, unknown> = {}
  ): BucketableSignal => ({
    id,
    kind: "owed-slot",
    count: 1,
    blockedReason: "credential",
    ...extra,
  });
  const ids = (signals: BucketableSignal[]) =>
    orderNeedsYouSignals(signals).map((s) => s.id);

  it("a P0 row goes before a goal judgement and every bucket", () => {
    const judgement: BucketableSignal = {
      id: "judge",
      kind: "notification",
      count: 1,
      notificationType: "track.review_ready",
    };
    const decision = row("decide", { blockedReason: "decision" });
    expect(ids([judgement, decision, row("due", { priority: "P0" })])).toEqual([
      "due",
      "judge",
      "decide",
    ]);
  });

  it("inside a bucket, louder first; a row with no priority reads P1 and keeps its place", () => {
    expect(
      ids([
        row("whenever", { priority: "P2" }),
        row("unstamped"),
        row("digest", { priority: "P3" }),
        row("waiting", { priority: "P1" }),
      ])
    ).toEqual(["unstamped", "waiting", "whenever", "digest"]);
  });

  it("never crosses a bucket: a P1 question stays after a P2 decision", () => {
    expect(
      ids([
        row("question", { priority: "P1" }),
        row("decision", { priority: "P2", blockedReason: "decision" }),
      ])
    ).toEqual(["decision", "question"]);
  });
});

describe("the notification level (the existing notifications.priority scale)", () => {
  it("P1 is the session.needs_you default 'high'; P0 urgent, P2 normal, P3 low", () => {
    expect(NEEDS_YOU_PRIORITY_NOTIFICATION_LEVEL).toEqual({
      P0: "urgent",
      P1: "high",
      P2: "normal",
      P3: "low",
    });
    expect(loudestNeedsYouPriority(["P2", "P0", "P3"])).toBe("P0");
    expect(loudestNeedsYouPriority([])).toBeNull();
  });
});
