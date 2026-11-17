import { describe, expect, it } from "vitest";
import {
  isReactionRuleId,
  reactionActivityPhrase,
  reactionOriginLine,
  reactionOutcomeLine,
  reactionPauseConsequence,
  reactionRuleAction,
  reactionRuleFacts,
  reactionRuleHealth,
  reactionRuleOrigin,
  reactionTerminalLine,
  ruleOriginLabel,
  type ReactionRuleWire,
} from "./reaction-rule-rows";
import { ruleCounts, ruleMatches, rulePill } from "./rule-rows";

const outcome = (
  o: "applied" | "proposed" | "skipped",
  code = o as string
) => ({
  outcome: o,
  code,
  reason: `why ${code}`,
  at: new Date().toISOString(),
  target: "entity:x",
  to: "complete",
});

const rule = (over: Partial<ReactionRuleWire> = {}): ReactionRuleWire => ({
  id: "declared:rollup:rel:post:campaign",
  title: "When every post part of a campaign is done, the campaign moves on",
  when: "A post moves to done or lost",
  via: "the campaign it is part of",
  do: "moves to its next status once every part is done",
  enabled: true,
  source: "declared",
  chains: false,
  terminal: "propose",
  terminalWhy: null,
  ruleId: "11111111-1111-4111-8111-111111111111",
  owner: { userId: "u", name: "Founder" },
  recent: [],
  declaredOn: {
    relationName: "Part of",
    source: { name: "Post" },
    target: { name: "Campaign" },
    workspaceId: null,
  },
  ...over,
});

describe("a pod rule in the one Rules list", () => {
  it("knows its ids apart from an automation's", () => {
    expect(isReactionRuleId("builtin:stopped-run-needs-you")).toBe(true);
    expect(isReactionRuleId("declared:rollup:a:b:c")).toBe(true);
    expect(isReactionRuleId("11111111-1111-4111-8111-111111111111")).toBe(
      false
    );
  });

  it("filters like any rule: on is Active, paused is Paused, never acted is Never ran", () => {
    const on = rule({ recent: [outcome("applied")] });
    const paused = rule({ id: "builtin:x", enabled: false });
    const idle = rule({ id: "builtin:y" });
    const facts = [on, paused, idle].map(reactionRuleFacts);
    const health = new Map(
      [on, paused, idle].map((r) => [r.id, reactionRuleHealth(r)])
    );
    const counts = ruleCounts(facts, (id) => health.get(id));
    expect(counts).toMatchObject({ active: 2, paused: 1, "never-ran": 1 });
    expect(ruleMatches("paused", facts[1]!, health.get("builtin:x"))).toBe(
      true
    );
    expect(rulePill(facts[0]!, health.get(on.id))).toEqual({
      kind: "healthy",
      label: "Working",
    });
    expect(rulePill(facts[1]!, undefined).label).toBe("Paused");
  });

  it("a failed write reads as failing", () => {
    const r = rule({ recent: [outcome("skipped", "failed")] });
    const facts = reactionRuleFacts(r);
    expect(ruleMatches("failing", facts, reactionRuleHealth(r))).toBe(true);
    expect(rulePill(facts, reactionRuleHealth(r)).kind).toBe("down");
  });

  it("offers Pause when on and Turn on when paused, never Run now", () => {
    expect(
      reactionRuleAction(rule({ recent: [outcome("skipped", "failed")] }))
    ).toBe("pause");
    expect(reactionRuleAction(rule({ enabled: false }))).toBe("turn_on");
  });

  it("says what it did lately, where it comes from, and what happens at done or lost", () => {
    expect(reactionActivityPhrase(rule())).toBe("Nothing lately");
    expect(
      reactionActivityPhrase(
        rule({
          recent: [
            outcome("applied"),
            outcome("applied"),
            outcome("skipped", "paused"),
          ],
        })
      )
    ).toBe("2 applied · 1 skipped lately");
    expect(reactionOriginLine(rule())).toBe(
      "Declared on the link “Post part of Campaign”"
    );
    expect(reactionOriginLine(rule({ declaredOn: null }))).toBe(
      "Built into the pod"
    );
    expect(reactionTerminalLine(rule())).toBe(
      "Moves into done or lost wait for your review."
    );
    expect(
      reactionTerminalLine(rule({ terminal: "apply", terminalWhy: "Trusted." }))
    ).toBe("Moves into done or lost are applied: Trusted.");
  });

  it("a history line names the outcome and keeps a skip's reason", () => {
    expect(
      reactionOutcomeLine(outcome("skipped", "moved_meanwhile"))
    ).toMatchObject({
      label: "Skipped",
      tone: "unknown",
      detail: "why moved_meanwhile",
    });
    // The log proves a proposal was filed, never that it still waits: its
    // words (which name the thing) are kept, never "Waiting for your review".
    expect(reactionOutcomeLine(outcome("proposed"))).toEqual(
      expect.objectContaining({
        label: "Proposed",
        tone: "stale",
        detail: "why proposed",
      })
    );
    expect(reactionOutcomeLine(outcome("proposed")).detail).not.toMatch(
      /waiting/i
    );
  });

  it("says where each row comes from, and that a pause is the whole pod's", () => {
    expect(ruleOriginLabel(reactionRuleOrigin(rule()))).toBe(
      "Declared on a link"
    );
    expect(
      ruleOriginLabel(reactionRuleOrigin(rule({ source: "built_in" })))
    ).toBe("Built in");
    expect(ruleOriginLabel("yours")).toBe("Yours");
    const said = reactionPauseConsequence(rule());
    expect(said).toMatch(/^This pauses it for everyone in this pod\./);
    expect(said).toContain(
      "this no longer happens: a post moves to done or lost, then the campaign it is part of moves to its next status once every part is done."
    );
    expect(said).toMatch(/Nothing it already did is undone\.$/);
  });
});
