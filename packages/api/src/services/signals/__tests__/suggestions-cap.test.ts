/**
 * "POSSIBILITIES", CAPPED (V1 W7) — the suggestions lens and its count never
 * hand a surface more than `SUGGESTIONS_CAP` AI suggestions, newest first, and
 * the count equals the rows. Pure: the same partition the router reads.
 */
import { describe, it, expect } from "vitest";
import { SUGGESTIONS_CAP } from "@synap-core/types/needs-you";
import {
  countNeedsYou,
  unionSuggestions,
  type NotificationSignalInput,
} from "../needs-you-union.js";

/** An `ai.proactive.suggestion` — registry role `suggestion`. */
function suggestion(i: number): NotificationSignalInput {
  return {
    id: `s-${i}`,
    type: "ai.proactive.suggestion",
    title: `Possibility ${i}`,
    category: "ai",
    sourceType: "system",
    sourceId: null,
    createdAt: new Date(Date.UTC(2026, 8, 28, 8, i)),
  } as NotificationSignalInput;
}

const count = (notifications: NotificationSignalInput[]) =>
  countNeedsYou({
    distinctClusters: 0,
    clustersTruncated: false,
    clusters: [],
    notifications,
    notificationsTruncated: false,
    owedSlots: [],
    owedTruncated: false,
  }).suggestions;

describe("possibilities are capped", () => {
  it("the cap is a small stated number", () => {
    expect(SUGGESTIONS_CAP).toBe(5);
  });

  it("offers only the newest SUGGESTIONS_CAP, and the count equals the rows", () => {
    const many = Array.from({ length: 12 }, (_, i) => suggestion(i));
    const rows = unionSuggestions(many);
    expect(rows).toHaveLength(SUGGESTIONS_CAP);
    expect(rows.map((r) => r.id)).toEqual(
      [11, 10, 9, 8, 7].map((i) => expect.stringContaining(`s-${i}`))
    );
    expect(count(many)).toBe(rows.length);
  });

  it("under the cap, everything shows (non-vacuity: the partition sees them)", () => {
    const few = [suggestion(1), suggestion(2)];
    expect(unionSuggestions(few)).toHaveLength(2);
    expect(count(few)).toBe(2);
  });
});
