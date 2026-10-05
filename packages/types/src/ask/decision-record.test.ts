import { describe, expect, it } from "vitest";
import { decisionRecordView } from "./index.js";

const opts = [
  {
    label: "EU region",
    value: "eu",
    recommended: true,
    description: " Closest ",
  },
  { label: "US region", value: "us" },
  { label: "Asia" },
];

describe("decisionRecordView", () => {
  it("marks recommended / chosen by value ?? label and reads followed", () => {
    const v = decisionRecordView({
      decisionStatus: "accepted",
      decisionOptions: opts,
      chosenOption: "eu",
      followedRecommendation: true,
      sourceSessionId: "s1",
    });
    expect(v.status).toBe("accepted");
    expect(v.sourceSessionId).toBe("s1");
    expect(v.options.map((o) => [o.key, o.recommended, o.chosen])).toEqual([
      ["eu", true, true],
      ["us", false, false],
      ["Asia", false, false],
    ]);
    expect(v.options[0]!.description).toBe("Closest");
    expect(v.outcome).toEqual({ outcome: "followed", recommendedLabel: null });
  });

  it("overrode names the recommended label; chosen by label key works", () => {
    const v = decisionRecordView({
      decisionOptions: opts,
      recommendedOption: "eu",
      chosenOption: "Asia",
      followedRecommendation: false,
    });
    expect(v.outcome).toEqual({
      outcome: "overrode",
      recommendedLabel: "EU region",
    });
    expect(v.options[2]!.chosen).toBe(true);
  });

  it("a missing followedRecommendation is none, never overrode", () => {
    const v = decisionRecordView({ decisionOptions: opts, chosenOption: "us" });
    expect(v.outcome.outcome).toBe("none");
    expect(v.options[0]!.recommended).toBe(true);
  });

  it("no recommendation at all is none even if followed=false", () => {
    const v = decisionRecordView({
      decisionOptions: [{ label: "A" }],
      followedRecommendation: false,
    });
    expect(v.outcome.outcome).toBe("none");
  });

  it("blank value falls back to the label as the key", () => {
    const v = decisionRecordView({
      decisionOptions: [{ label: "A", value: "  " }],
      chosenOption: "A",
    });
    expect(v.options[0]).toMatchObject({ key: "A", chosen: true });
  });

  it("garbage yields an empty honest view and never throws", () => {
    for (const bad of [
      null,
      undefined,
      3,
      "x",
      [],
      { decisionOptions: "nope" },
      { decisionOptions: [null, 1, {}, { label: "  " }] },
    ]) {
      const v = decisionRecordView(bad);
      expect(v.options).toEqual([]);
      expect(v.status).toBeNull();
      expect(v.sourceSessionId).toBeNull();
      expect(v.outcome).toEqual({ outcome: "none", recommendedLabel: null });
    }
  });
});
