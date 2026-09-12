/**
 * GOAL OVERRIDE — the rule states what the session is FOR.
 *
 * Without it a `playbook_run` THEN could only inherit the playbook's own
 * `goalTemplate`, so every rule running the same playbook spawned a session with
 * an identical goal and the reason THIS rule fired appeared nowhere in it.
 *
 * These drive the REAL `executePlaybookRun` and inspect what it hands the spine,
 * rather than re-implementing the resolver rule in the test. (Its sibling
 * `playbook-run.goal-grammar.test.ts` mirrors the rule in a local helper, which
 * cannot see a change to the real closure — this one can, which is why the
 * override is pinned here.)
 *
 * The load-bearing property is that BOTH template grammars reach the override:
 *   • `{{mustache}}` — resolved here, against the automation StepContext, and
 *     handed over as the already-resolved goal.
 *   • `@{arg:name:type}` — NOT resolvable here; the resolver correctly declines
 *     ("wrong resolver for this grammar"), and the OVERRIDE TEMPLATE itself must
 *     travel to the spine as `goalTemplateOverride`. Without that field the
 *     spine's own `resolveGoal` would substitute the PLAYBOOK's template and the
 *     rule's goal would vanish silently — the exact shape of the 49-session bug,
 *     one layer up.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { runnerMock, entityFindFirstMock } = vi.hoisted(() => ({
  runnerMock: vi.fn(async (_input: unknown) => ({
    run: { id: "run-1", status: "running" },
    session: { id: "sess-run", channelId: "chan-1" },
  })),
  entityFindFirstMock: vi.fn(async () => undefined),
}));

vi.mock("@synap/database", () => ({
  db: {
    query: { entities: { findFirst: entityFindFirstMock } },
    update: () => ({
      set: () => ({ where: () => Promise.resolve(undefined) }),
    }),
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  entities: {},
  events: {},
  proposals: {},
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: vi.fn(),
  verifyPermission: vi.fn(),
}));
vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: vi.fn(async () => ({
    decision: "not-agent" as const,
  })),
}));
vi.mock("@synap/governance-policy", () => ({
  requiredPermissionFor: vi.fn(() => "write"),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { executePlaybookRun } from "../playbook-run.js";
import { registerPlaybookRunner } from "../../capability-dispatch.js";
import type { StepContext } from "../../automation-executor-types.js";

/** The playbook's OWN goal — what a node with no override must still get. */
const PLAYBOOK_TEMPLATE = "Run the standard {{trigger.payload.kind}} review";

const context = () =>
  ({
    trigger: { payload: { kind: "quarterly", title: "Acme" } },
    steps: {},
    automation: { id: "auto-1", state: {} },
  }) as unknown as StepContext;

/** Run the step and return what the spine was handed. */
async function runWith(goalOverride?: string) {
  await executePlaybookRun(
    { playbookId: "pb-1", ...(goalOverride ? { goalOverride } : {}) },
    context(),
    "ws-1",
    "user-1"
  );
  const input = runnerMock.mock.calls[0][0] as {
    goalResolver?: (t: string) => string | undefined;
    goalTemplateOverride?: string;
  };
  return {
    // What the spine gets when it applies the resolver to the PLAYBOOK's own
    // template — i.e. the goal the session is actually born with.
    resolved: input.goalResolver?.(PLAYBOOK_TEMPLATE),
    goalTemplateOverride: input.goalTemplateOverride,
  };
}

beforeEach(() => {
  runnerMock.mockClear();
  registerPlaybookRunner(runnerMock as never);
});

describe("playbook_run — the rule's goal reaches the session", () => {
  it("no override ⇒ the playbook's own goalTemplate, resolved (unchanged)", async () => {
    const { resolved, goalTemplateOverride } = await runWith();
    expect(resolved).toBe("Run the standard quarterly review");
    expect(goalTemplateOverride).toBeUndefined();
  });

  it("a {{mustache}} override REPLACES the playbook's goal and interpolates", async () => {
    const { resolved } = await runWith(
      "Qualify {{trigger.payload.title}} for the Q3 pipeline"
    );
    expect(resolved).toBe("Qualify Acme for the Q3 pipeline");
    // And the playbook's own wording is gone — the override is a replacement,
    // not an addition.
    expect(resolved).not.toContain("standard");
  });

  it("an @{arg:} override DEFERS, and the template itself travels to the spine", async () => {
    const OVERRIDE = "Brief @{arg:company:entity} before the call";
    const { resolved, goalTemplateOverride } = await runWith(OVERRIDE);

    // Declines — this resolver does not speak that grammar, and passing the raw
    // placeholder on is the bug this whole lane exists to prevent.
    expect(resolved).toBeUndefined();
    expect(resolved ?? "").not.toContain("@{arg:");

    // …so the OVERRIDE must reach the spine intact. If it did not, the spine
    // would fall back to resolving the PLAYBOOK's template and the rule's goal
    // would be silently discarded with every type green.
    expect(goalTemplateOverride).toBe(OVERRIDE);
  });

  it("a blank override is not an override", async () => {
    // Whitespace is authoring noise, not an instruction. Treating it as one
    // would replace a real goal with an empty prompt.
    const { resolved, goalTemplateOverride } = await runWith("   ");
    expect(resolved).toBe("Run the standard quarterly review");
    expect(goalTemplateOverride).toBe("   ");
  });
});
