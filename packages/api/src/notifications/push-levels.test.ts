/**
 * Push levels (founder decision 9bc9f75c, 2026-11-04), pure half of the push
 * decision: an ask due within the hour is never held back by the person's
 * daily budget (it breaks Focus; it still counts), and an agent's OWN push
 * limit — none by default — holds back that agent's earned pushes past it.
 * The envelope's level and Android channel are pinned in
 * `@synap-core/types/push` (`push.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { PUSH_DAILY_CAP } from "@synap-core/types/push";
import {
  agentPushLimitApplies,
  decidePush,
  pushCapApplies,
  withinAgentPushLimit,
  withinPushCap,
} from "./push-decision.js";

const AGENT = "44444444-4444-4444-8444-444444444444";

function ask(facts: { dueSoon?: boolean } = {}) {
  return decidePush({
    type: "session.needs_you",
    typeRule: undefined,
    facts,
    prefs: {},
  });
}

describe("an ask due within the hour", () => {
  it("is earned and marked dueSoon; a plain ask is not", () => {
    expect(ask({ dueSoon: true })).toEqual({
      push: true,
      category: "blocking-ask",
      reason: "earned",
      dueSoon: true,
    });
    expect(ask()).toEqual({
      push: true,
      category: "blocking-ask",
      reason: "earned",
    });
  });

  it("is never held back by the daily budget; a plain ask is", () => {
    expect(pushCapApplies(ask({ dueSoon: true }))).toBe(false);
    expect(withinPushCap(ask({ dueSoon: true }), PUSH_DAILY_CAP + 5).push).toBe(
      true
    );
    expect(pushCapApplies(ask())).toBe(true);
    expect(withinPushCap(ask(), PUSH_DAILY_CAP)).toMatchObject({
      push: false,
      reason: "over_cap",
    });
  });

  it("dueSoon on a type that does not wait on the person changes nothing", () => {
    const broke = decidePush({
      type: "agent.task_failed",
      typeRule: undefined,
      facts: { dueSoon: true },
      prefs: {},
    });
    expect(broke).toEqual({
      push: true,
      category: "work-broke",
      reason: "earned",
    });
  });
});

describe("an agent's own push limit", () => {
  it("applies only when the person set one and an agent is known", () => {
    expect(agentPushLimitApplies(ask(), AGENT, null)).toBe(false);
    expect(agentPushLimitApplies(ask(), undefined, 1)).toBe(false);
    expect(agentPushLimitApplies(ask(), AGENT, 1)).toBe(true);
    // It holds the agent's urgent asks too: the person limited THIS agent.
    expect(agentPushLimitApplies(ask({ dueSoon: true }), AGENT, 1)).toBe(true);
  });

  it("holds back the push past the limit, and nothing below it", () => {
    expect(withinAgentPushLimit(ask(), 2, 1).push).toBe(true);
    expect(withinAgentPushLimit(ask(), 2, 2)).toEqual({
      push: false,
      category: "blocking-ask",
      reason: "over_agent_limit",
    });
    expect(withinAgentPushLimit(ask(), 0, 0)).toMatchObject({
      push: false,
      reason: "over_agent_limit",
    });
    // Unlimited (the default) never holds back.
    expect(withinAgentPushLimit(ask(), null, 99).push).toBe(true);
  });

  it("never holds back a forced push or something that broke", () => {
    const forced = decidePush({
      type: "session.needs_you",
      typeRule: "os",
      facts: {},
      prefs: {},
    });
    expect(agentPushLimitApplies(forced, AGENT, 0)).toBe(false);
    expect(withinAgentPushLimit(forced, 0, 5).push).toBe(true);
    const broke = decidePush({
      type: "agent.task_failed",
      typeRule: undefined,
      facts: {},
      prefs: {},
    });
    expect(agentPushLimitApplies(broke, AGENT, 0)).toBe(false);
    expect(withinAgentPushLimit(broke, 0, 5).push).toBe(true);
  });
});
