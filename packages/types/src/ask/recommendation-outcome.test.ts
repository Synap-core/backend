import { describe, expect, it } from "vitest";
import {
  ASK_COPY,
  AskSchema,
  askRecommendationOutcome,
  buildAskSnapshot,
  type Ask,
} from "./index.js";

const ask = (a: unknown): Ask => AskSchema.parse(a);
const recommendedChoose = ask({
  mode: "choose",
  allowOther: true,
  options: [
    { label: "EU region", value: "eu", recommended: true },
    { label: "US region", value: "us" },
  ],
});
const plainChoose = ask({
  mode: "choose",
  options: [
    { label: "EU", value: "eu" },
    { label: "US", value: "us" },
  ],
});
const chip = (label: string, value: string) =>
  ({ type: "chip", chip: { label, value } }) as const;

// Every row is driven through the REAL snapshot builder, so the rule reads
// what the pod stores, not a hand-built shape.
describe("askRecommendationOutcome", () => {
  it("followed: the recommended option was picked", () => {
    const snap = buildAskSnapshot(recommendedChoose, chip("EU region", "eu"));
    expect(askRecommendationOutcome(snap)).toEqual({
      outcome: "followed",
      recommendedLabel: null,
    });
  });

  it("overrode: another option, and it names what the AI picked", () => {
    const snap = buildAskSnapshot(recommendedChoose, chip("US region", "us"));
    expect(askRecommendationOutcome(snap)).toEqual({
      outcome: "overrode",
      recommendedLabel: "EU region",
    });
  });

  it("overrode: an Other… answer in the person's own words", () => {
    const snap = buildAskSnapshot(recommendedChoose, { type: "text" });
    expect(askRecommendationOutcome(snap).outcome).toBe("overrode");
  });

  it("none: a room reply in words (pick unknown, never 'overrode')", () => {
    const snap = buildAskSnapshot(recommendedChoose, undefined);
    expect(askRecommendationOutcome(snap).outcome).toBe("none");
  });

  it("none: nothing was recommended (a choose without one, any confirm)", () => {
    expect(
      askRecommendationOutcome(buildAskSnapshot(plainChoose, chip("US", "us")))
        .outcome
    ).toBe("none");
    const confirmSnap = buildAskSnapshot(ask({ mode: "confirm" }), {
      type: "confirm",
      confirmed: false,
    });
    expect(confirmSnap.recommendedKey).toBeNull();
    expect(askRecommendationOutcome(confirmSnap).outcome).toBe("none");
  });

  it("reads an answer carrying the snapshot, and tolerates absence", () => {
    const askSnapshot = buildAskSnapshot(
      recommendedChoose,
      chip("US region", "us")
    );
    expect(askRecommendationOutcome({ askSnapshot }).outcome).toBe("overrode");
    expect(askRecommendationOutcome({ askSnapshot: null }).outcome).toBe(
      "none"
    );
    expect(askRecommendationOutcome({}).outcome).toBe("none");
    expect(askRecommendationOutcome(null).outcome).toBe("none");
  });

  it("has copy for both marks", () => {
    expect(ASK_COPY.followedAiPick).toBe("Followed AI pick");
    expect(ASK_COPY.choseDifferently).toBe("Chose differently from AI");
    expect(ASK_COPY.aiPicked("EU region")).toBe("AI picked: EU region");
  });
});
