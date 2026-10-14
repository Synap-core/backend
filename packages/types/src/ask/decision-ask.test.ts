import { describe, expect, it } from "vitest";
import {
  AskSchema,
  askRowRegion,
  deriveDecisionAsk,
  effectiveSlotAsk,
  resolveAskResolution,
  type Ask,
} from "./index.js";
import { PARAM_SLOT_KIND } from "../focus-sessions/param-slot.js";

// Ticket #12: a `decision` slot with no ask was closed by a one-tap "I did
// this" 21 s after the session started. A decision is a choice, never a bare
// "done".
const decision = {
  kind: "decision",
  label: "Approve the launch scope",
  owner: "human",
  blockedReason: "decision",
  why: "Scope decides the budget",
};

describe("deriveDecisionAsk — a decision is a choice", () => {
  it("a person-owed decision with no ask becomes a confirm on its why", () => {
    const ask = deriveDecisionAsk(decision);
    expect(ask).toEqual({
      mode: "confirm",
      prompt: "Scope decides the budget",
    });
    // A valid ask on the wire: it is stored as-is at declaration.
    expect(AskSchema.safeParse(ask).success).toBe(true);
  });

  it("falls back to the label when there is no why", () => {
    expect(deriveDecisionAsk({ ...decision, why: "  " })).toEqual({
      mode: "confirm",
      prompt: "Approve the launch scope",
    });
  });

  it("clips the prompt to the confirm's bound", () => {
    const ask = deriveDecisionAsk({ ...decision, why: "w".repeat(900) });
    expect(ask?.mode === "confirm" && ask.prompt?.length).toBe(500);
  });

  // Each row rules out a looser rule: no owner check, no reason check, no
  // param exemption, or overwriting an ask the agent declared.
  it.each([
    ["an agent-owned slot", { ...decision, owner: "agent" }],
    ["an un-owned slot", { ...decision, owner: undefined }],
    ["another blocker", { ...decision, blockedReason: "credential" }],
    ["no blocker", { ...decision, blockedReason: undefined }],
    ["a credential param slot", { ...decision, kind: PARAM_SLOT_KIND }],
    [
      "a slot that already carries an ask",
      { ...decision, ask: { mode: "act" } as Ask },
    ],
  ])("derives nothing for %s", (_name, slot) => {
    expect(deriveDecisionAsk(slot)).toBeNull();
  });
});

describe("effectiveSlotAsk — what every surface and door resolves through", () => {
  it("a decision with no ask resolves through the ANSWER door, inline", () => {
    // The slot's own ask (none) is legacy → "I did this".
    const stored: { ask?: Ask } = decision;
    expect(askRowRegion(stored.ask, { canAnswer: true })).toBe("legacy");
    const ask = effectiveSlotAsk(decision);
    expect(resolveAskResolution(ask)).toBe("answer");
    expect(askRowRegion(ask as Ask, { canAnswer: true })).toBe("inline");
  });

  it("a stored ask wins over the derivation", () => {
    const act: Ask = { mode: "act", url: "https://example.com" };
    expect(effectiveSlotAsk({ ...decision, ask: act })).toBe(act);
  });

  it("an ordinary slot with no ask stays legacy", () => {
    const ask = effectiveSlotAsk({ label: "Upload the deck", owner: "human" });
    expect(ask).toBeNull();
    expect(resolveAskResolution(ask)).toBe("legacy");
  });
});
