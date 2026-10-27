import { describe, expect, it } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import { restatedAskHints, withoutRestatedWhy } from "../ask-text.js";
import { reconcileOwedSince } from "../update-session.js";

const confirm = (prompt: string) => ({ mode: "confirm" as const, prompt });

describe("withoutRestatedWhy — an owed ask says it once", () => {
  it("drops a why that is the prompt again (case, punctuation, verb prefix aside)", () => {
    const slot = withoutRestatedWhy({
      why: "accept: pricing model",
      ask: confirm("Accept: Pricing model?"),
    });
    expect(slot).not.toHaveProperty("why");
  });

  it("cuts the prompt off the end of a why that carries facts before it (a room question)", () => {
    expect(
      withoutRestatedWhy({
        why: "This run stopped 3 times. Keep it going?",
        ask: confirm("Keep it going?"),
      }).why
    ).toBe("This run stopped 3 times.");
  });

  it("keeps a why that adds something, and anything without a confirm prompt", () => {
    const adds = { why: "Scope decides the budget", ask: confirm("Ship it?") };
    expect(withoutRestatedWhy(adds)).toBe(adds);
    const choose = {
      why: "Which account?",
      ask: { mode: "choose" as const, options: [{ label: "EU" }, { label: "US" }] },
    };
    expect(withoutRestatedWhy(choose)).toBe(choose);
  });
});

describe("every write door drops it — reconcileOwedSince", () => {
  const slot: ExpectedOutput = {
    kind: "decision",
    label: "Launch scope",
    owner: "human",
    blockedReason: "decision",
    why: "Ship the EU launch?",
    ask: confirm("Ship the EU launch?"),
  };
  it("on a person-owned slot", () => {
    expect(reconcileOwedSince(slot)).not.toHaveProperty("why");
  });
  it("never on an agent-owned one (nothing is asked there)", () => {
    const { owner: _o, ...agents } = slot;
    expect(reconcileOwedSince(agents).why).toBe("Ship the EU launch?");
  });
});

describe("restatedAskHints", () => {
  it("hints when a person's confirm prompt only repeats the label, and only then", () => {
    expect(
      restatedAskHints([
        { label: "Decide: Pricing model", owner: "human", ask: confirm("Accept: Pricing model?") },
        { label: "Stripe account", owner: "human", ask: confirm("Bill EU customers from the EU account?") },
        { label: "Ship it", ask: confirm("Ship it?") },
      ])
    ).toEqual([expect.stringContaining('"Decide: Pricing model": the prompt repeats the label')]);
  });
});
