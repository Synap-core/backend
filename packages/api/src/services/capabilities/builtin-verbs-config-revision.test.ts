/**
 * `playbook.update` / `automation.update` / `automation.activate` /
 * `automation.pause` — the CONFIG REVISION verbs.
 *
 * THE DEFECT THEY CLOSE: the capability substrate could BUILD config
 * (`playbook.create`, `automation.create`) but never REVISE it. A live playbook
 * whose `subjectProfile` pointed at a kind that no longer exists could not be
 * repaired from any agent surface, and an agent-authored automation — which
 * always lands `draft` — could never be switched on.
 *
 * WHAT THESE TESTS PIN, and it is deliberately narrow: that each handler
 * re-enters the EXISTING governed tRPC procedure and FORWARDS its fields there
 * (a `createCaller` on the real router, the right procedure, the right
 * payload), and that a governed `{ status: "proposed" }` return is surfaced
 * VERBATIM rather than swallowed or re-labelled. That is exactly the seam the
 * verbs own; everything downstream of the procedure call (the workspace gate,
 * `checkPermissionOrPropose`, `assertSubjectProfileResolves`, the flow/verb
 * revalidation) belongs to the routers and is tested there.
 *
 * WHAT THEY DO **NOT** COVER, measured: the routers are mocked, so nothing here
 * proves the real gate fires. `subjectProfile` validation in particular is
 * asserted only as PASS-THROUGH — that the field reaches `playbooks.update`
 * unaltered, which is the precondition for that door's own
 * `assertSubjectProfileResolves` to see it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  playbookUpdateCalls: [] as Array<Record<string, unknown>>,
  automationUpdateCalls: [] as Array<Record<string, unknown>>,
  automationActivateCalls: [] as Array<Record<string, unknown>>,
  automationPauseCalls: [] as Array<Record<string, unknown>>,
  playbookUpdateResult: {} as unknown,
}));

vi.mock("../../routers/playbooks.js", () => ({
  playbooksRouter: {
    createCaller: () => ({
      update: async (input: Record<string, unknown>) => {
        h.playbookUpdateCalls.push(input);
        return h.playbookUpdateResult;
      },
    }),
  },
}));

vi.mock("../../routers/automations.js", () => ({
  automationsRouter: {
    createCaller: () => ({
      update: async (input: Record<string, unknown>) => {
        h.automationUpdateCalls.push(input);
        return { status: "updated", message: "Automation updated" };
      },
      activate: async (input: Record<string, unknown>) => {
        h.automationActivateCalls.push(input);
        return { status: "proposed", proposalId: "prop-activate-1" };
      },
      pause: async (input: Record<string, unknown>) => {
        h.automationPauseCalls.push(input);
        return { status: "paused" };
      },
    }),
  },
}));

import { BUILTIN_VERBS, READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const PLAYBOOK = "dcbdbb10-958d-4d81-a9ef-2d7958dc2f09";
const AUTOMATION = "44444444-4444-4444-8444-444444444444";

const ctx = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  workspaceId: WS,
  ...over,
});

beforeEach(() => {
  h.playbookUpdateCalls = [];
  h.automationUpdateCalls = [];
  h.automationActivateCalls = [];
  h.automationPauseCalls = [];
  h.playbookUpdateResult = {
    playbook: null,
    status: "proposed",
    proposalId: "prop-playbook-1",
  };
});

describe("the four config-revision verbs are registered as WRITES", () => {
  it("each is dispatchable from BUILTIN_VERBS", () => {
    // Derived, not hand-listed: the four names this file drives.
    for (const verb of [
      "playbook.update",
      "automation.update",
      "automation.activate",
      "automation.pause",
    ]) {
      expect(typeof BUILTIN_VERBS[verb], `${verb} is not dispatchable`).toBe(
        "function"
      );
    }
  });

  it("none of them is marked read-only (they must flow through the full gate)", () => {
    for (const verb of [
      "playbook.update",
      "automation.update",
      "automation.activate",
      "automation.pause",
    ]) {
      expect(
        READ_ONLY_BUILTIN_VERBS.has(verb),
        `${verb} is in READ_ONLY_BUILTIN_VERBS — the capability gate would ` +
          `AUTO-RUN a write with no grant and no proposal`
      ).toBe(false);
    }
    // Self-check: the set is real and can still see a genuine read-only verb.
    expect(READ_ONLY_BUILTIN_VERBS.has("entity.query")).toBe(true);
  });
});

describe("playbook.update", () => {
  it("forwards every patch field to playbooks.update, subjectProfile included", async () => {
    const result = await BUILTIN_VERBS["playbook.update"]!(
      {
        playbookId: PLAYBOOK,
        name: "Qualify a CRM lead",
        description: "desc",
        goalTemplate: "Qualify {{lead}}",
        subjectProfile: { profileSlug: "lead" },
        stages: [{ key: "intake", name: "Intake", category: "backlog" }],
        criteria: [{ key: "k", statement: "s", check: { kind: "human" } }],
        status: "active",
        executor: "is-agent",
        reasoning: "repair the dangling subject",
      },
      ctx({ agentUserId: AGENT })
    );

    expect(h.playbookUpdateCalls).toHaveLength(1);
    const sent = h.playbookUpdateCalls[0]!;
    expect(sent).toMatchObject({
      id: PLAYBOOK,
      agentUserId: AGENT,
      reasoning: "repair the dangling subject",
      name: "Qualify a CRM lead",
      description: "desc",
      goalTemplate: "Qualify {{lead}}",
      // THE REPAIR PATH: the field reaches the one door that validates it.
      subjectProfile: { profileSlug: "lead" },
      status: "active",
      executor: "is-agent",
    });
    expect(sent.stages).toEqual([
      { key: "intake", name: "Intake", category: "backlog" },
    ]);
    expect(sent.criteria).toEqual([
      { key: "k", statement: "s", check: { kind: "human" } },
    ]);

    // `proposed` is surfaced VERBATIM — never swallowed into a fake success.
    expect(result).toEqual({
      playbook: null,
      status: "proposed",
      proposalId: "prop-playbook-1",
    });
  });

  it("omits what the caller omitted — a patch never clears a field by accident", async () => {
    await BUILTIN_VERBS["playbook.update"]!(
      { playbookId: PLAYBOOK, name: "Just a rename" },
      ctx()
    );
    const sent = h.playbookUpdateCalls[0]!;
    expect(Object.keys(sent).sort()).toEqual(["id", "name"]);
  });

  it("refuses a call with no playbookId at the schema", async () => {
    await expect(
      BUILTIN_VERBS["playbook.update"]!({ name: "x" }, ctx())
    ).rejects.toThrow();
    expect(h.playbookUpdateCalls).toHaveLength(0);
  });
});

describe("automation.update", () => {
  it("forwards the definition patch to automations.update", async () => {
    const flow = { nodes: [{ id: "n1" }], edges: [] };
    const result = await BUILTIN_VERBS["automation.update"]!(
      {
        automationId: AUTOMATION,
        name: "Morning recap",
        description: "d",
        triggerType: "cron",
        triggerConfig: { expression: "0 9 * * *" },
        flowDefinition: flow,
        metadata: { dataContract: { x: 1 } },
      },
      ctx()
    );

    expect(h.automationUpdateCalls).toHaveLength(1);
    expect(h.automationUpdateCalls[0]).toMatchObject({
      id: AUTOMATION,
      workspaceId: WS,
      name: "Morning recap",
      description: "d",
      triggerType: "cron",
      triggerConfig: { expression: "0 9 * * *" },
      flowDefinition: flow,
      metadata: { dataContract: { x: 1 } },
    });
    expect(result).toEqual({
      status: "updated",
      message: "Automation updated",
    });
  });

  it("does NOT accept `status` — activation is not a status patch", async () => {
    // MEASURED REASON: `automations.update` writes `status` and computes
    // NOTHING else, so a cron automation activated that way reads "active" and
    // is never scheduled (`nextRunAt` stays null). The param is absent by
    // design, so a `status` here is REFUSED rather than silently dropped.
    await expect(
      BUILTIN_VERBS["automation.update"]!(
        { automationId: AUTOMATION, status: "active" },
        ctx()
      )
    ).rejects.toThrow();
    expect(h.automationUpdateCalls).toHaveLength(0);
  });
});

describe("automation.activate / automation.pause", () => {
  it("activate re-enters automations.activate and surfaces `proposed` verbatim", async () => {
    const result = await BUILTIN_VERBS["automation.activate"]!(
      { automationId: AUTOMATION },
      ctx({ agentUserId: AGENT })
    );
    expect(h.automationActivateCalls).toEqual([
      { id: AUTOMATION, workspaceId: WS },
    ]);
    expect(result).toEqual({
      status: "proposed",
      proposalId: "prop-activate-1",
    });
  });

  it("pause re-enters automations.pause", async () => {
    const result = await BUILTIN_VERBS["automation.pause"]!(
      { automationId: AUTOMATION },
      ctx()
    );
    expect(h.automationPauseCalls).toEqual([
      { id: AUTOMATION, workspaceId: WS },
    ]);
    expect(result).toEqual({ status: "paused" });
  });

  it("both refuse a non-uuid automationId before reaching the router", async () => {
    await expect(
      BUILTIN_VERBS["automation.activate"]!({ automationId: "nope" }, ctx())
    ).rejects.toThrow();
    await expect(
      BUILTIN_VERBS["automation.pause"]!({ automationId: "nope" }, ctx())
    ).rejects.toThrow();
    expect(h.automationActivateCalls).toHaveLength(0);
    expect(h.automationPauseCalls).toHaveLength(0);
  });
});
