import { describe, expect, it } from "vitest";
import { latestBrief, MORNING_BRIEF_TYPE } from "./morning-brief-model";

const row = (id: string, type: string) => ({
  id,
  type,
  title: `${id} title`,
  body: `${id} body`,
  createdAt: "2026-10-30T07:00:00.000Z",
});

describe("latestBrief", () => {
  it("takes the newest morning brief, never another AI notification", () => {
    expect(
      latestBrief([
        row("digest", "ai.proactive.weekly_digest"),
        row("today", MORNING_BRIEF_TYPE),
        row("yesterday", MORNING_BRIEF_TYPE),
      ])?.id
    ).toBe("today");
  });

  it("answers null when no brief was raised, so the card can say so", () => {
    expect(latestBrief([row("digest", "ai.proactive.weekly_digest")])).toBe(
      null
    );
    expect(latestBrief([])).toBe(null);
  });

  it("names the type the pod's producer raises", () => {
    expect(MORNING_BRIEF_TYPE).toBe("ai.proactive.morning_briefing");
  });
});
