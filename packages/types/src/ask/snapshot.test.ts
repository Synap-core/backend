import { describe, expect, it } from "vitest";
import {
  AskSchema,
  AskSnapshotSchema,
  buildAskSnapshot,
  type Ask,
} from "./index.js";

const choose: Ask = AskSchema.parse({
  mode: "choose",
  options: [
    {
      label: "EU account",
      value: "eu",
      recommended: true,
      description: "→ EUR",
    },
    { label: "US account", value: "us" },
  ],
  allowOther: true,
  lookedAt: [{ kind: "entity", id: "e1" }],
});

describe("buildAskSnapshot — the ask as answered", () => {
  it("keeps the FULL option list, the recommendation and the pick", () => {
    const s = buildAskSnapshot(
      choose,
      { type: "chip", chip: { label: "US account", value: "us" } },
      "Which Stripe account?"
    );
    expect(s).toEqual({
      mode: "choose",
      why: "Which Stripe account?",
      options: choose.mode === "choose" ? choose.options : [],
      chosenKey: "us",
      recommendedKey: "eu",
      followedRecommendation: false,
      lookedAt: [{ kind: "entity", id: "e1" }],
    });
    expect(AskSnapshotSchema.safeParse(s).success).toBe(true);
  });

  it("followedRecommendation is TRUE when the pick is the recommended one", () => {
    const s = buildAskSnapshot(choose, {
      type: "chip",
      chip: { label: "EU account", value: "eu" },
    });
    expect(s.followedRecommendation).toBe(true);
  });

  it("free text against a recommendation is NOT following it", () => {
    const s = buildAskSnapshot(choose, { type: "text" });
    expect(s.chosenKey).toBeNull();
    expect(s.followedRecommendation).toBe(false);
  });

  it("a room reply in words (no value) is UNKNOWN, never false", () => {
    expect(buildAskSnapshot(choose, undefined).followedRecommendation).toBe(
      null
    );
  });

  it("no recommendation ⇒ null, never false", () => {
    const plain = AskSchema.parse({
      mode: "choose",
      options: [{ label: "A" }, { label: "B" }],
    });
    const s = buildAskSnapshot(plain, {
      type: "chip",
      chip: { label: "B" },
    });
    expect(s.recommendedKey).toBeNull();
    expect(s.followedRecommendation).toBeNull();
    expect(s.chosenKey).toBe("B");
  });

  it("a confirm records yes/no and its prompt", () => {
    const confirm = AskSchema.parse({ mode: "confirm", prompt: "Ship it?" });
    expect(
      buildAskSnapshot(confirm, { type: "confirm", confirmed: false })
    ).toEqual({
      mode: "confirm",
      prompt: "Ship it?",
      chosenKey: "no",
      recommendedKey: null,
      followedRecommendation: null,
    });
  });

  it("strips a resolved lookedAt title — provenance is {kind,id} only", () => {
    const withTitle = {
      ...choose,
      lookedAt: [{ kind: "entity" as const, id: "e1", title: "Leak" }],
    } as Ask;
    expect(buildAskSnapshot(withTitle, undefined).lookedAt).toEqual([
      { kind: "entity", id: "e1" },
    ]);
  });
});
