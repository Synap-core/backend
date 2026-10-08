/**
 * Activators → governed rules: compiled through the ONE rule door, linked as
 * `activator`, and IDEMPOTENT across re-install / reconcile / boot.
 *
 * The rule door (`createRuleGoverned` / `updateRuleGoverned`) and the lineage
 * reader are replaced by a STATEFUL fake that stores rules exactly as the door
 * does (`metadata.rule = { intent, scope, sentence, seed, draft? }`, one
 * compiled automation per rule), so each pass reads back what the previous one
 * wrote — the property under test is convergence over passes, not one call.
 * The door's own governance is covered by its suites; what is asserted here is
 * WHICH door call each pass makes, and that nothing is duplicated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const T = vi.hoisted(() => ({
  playbooks: Symbol("playbooks"),
  skills: Symbol("skills"),
  proposals: Symbol("proposals"),
  playbookAutomations: Symbol("playbook_automations"),
}));
const store = vi.hoisted(() => ({
  playbook: null as Row | null,
  rules: [] as Array<{ id: string; metadata: Row; automationId: string }>,
  offers: [] as Array<{ id: string; status: string }>,
  links: [] as Array<{ playbookId: string; automationId: string; role: string }>,
  agentProposes: false,
  seq: 0,
}));

// PARTIAL (importOriginal + spread), never total — the total-mock ratchet.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const select = () => ({
    from: (table: symbol) => {
      const rows = (): Row[] =>
        table === T.playbooks
          ? store.playbook
            ? [store.playbook]
            : []
          : table === T.skills
            ? store.rules.map((r) => ({ id: r.id, metadata: r.metadata }))
            : table === T.proposals
              ? store.offers
              : [];
      const q = {
        where: () => q,
        limit: async () => rows(),
        then: (res: (v: Row[]) => unknown) => Promise.resolve(rows()).then(res),
      };
      return q;
    },
  });
  return {
    ...actual,
    db: {
      select,
      insert: () => ({
        values: (v: { playbookId: string; automationId: string; role: string }) => ({
          onConflictDoUpdate: async () => {
            const hit = store.links.find(
              (l) =>
                l.playbookId === v.playbookId && l.automationId === v.automationId
            );
            if (hit) hit.role = v.role;
            else store.links.push({ ...v });
          },
        }),
      }),
      delete: () => ({
        where: async (pred: { keep: string[] }) => {
          store.links = store.links.filter(
            (l) => l.role !== "activator" || pred.keep.includes(l.automationId)
          );
        },
      }),
    },
    playbooks: T.playbooks,
    skills: T.skills,
    proposals: T.proposals,
    playbookAutomations: { playbookId: "pid", automationId: "aid", role: "role" },
    // The delete predicate: carry the kept automation ids to the fake.
    and: (...parts: unknown[]) => ({
      keep: (parts.find((p) => (p as { keep?: string[] })?.keep) as {
        keep: string[];
      } | undefined)?.keep ?? [],
    }),
    notInArray: (_c: unknown, ids: string[]) => ({ keep: ids }),
    eq: () => ({}),
    inArray: () => ({}),
    drizzleSql: () => ({}),
  };
});

vi.mock("../rules/create.js", () => ({
  createRuleGoverned: vi.fn(
    async (input: {
      intent: string;
      scope: Row;
      sentence?: unknown;
      seed?: Row;
      agentUserId?: string;
    }) => {
      if (input.agentUserId && store.agentProposes) {
        const id = `prop-${++store.seq}`;
        store.offers.push({ id, status: "pending" });
        return { status: "proposed", proposalId: id };
      }
      const id = `rule-${++store.seq}`;
      store.rules.push({
        id,
        automationId: `auto-${id}`,
        metadata: {
          rule: {
            v: 1,
            intent: input.intent,
            scope: input.scope,
            sentence: input.sentence,
            seed: input.seed,
            behaviours: [],
            createdAt: "2026-10-08T00:00:00.000Z",
          },
        },
      });
      return { status: "created", ruleId: id, automationIds: [`auto-${id}`] };
    }
  ),
}));
vi.mock("../rules/update.js", () => ({
  updateRuleGoverned: vi.fn(
    async (input: {
      ruleId: string;
      intent: string;
      sentence?: unknown;
      draft?: boolean;
      seed?: Row;
    }) => {
      const r = store.rules.find((x) => x.id === input.ruleId)!;
      const rule = r.metadata.rule as Row;
      rule.intent = input.intent;
      if (input.sentence !== undefined) rule.sentence = input.sentence;
      if (input.seed) rule.seed = input.seed;
      if (input.draft === true) rule.draft = true;
      if (input.draft === false) delete rule.draft;
      return {
        status: "updated",
        ruleId: r.id,
        automationIds: [r.automationId],
        draft: input.draft === true,
      };
    }
  ),
}));
vi.mock("../rules/lineage.js", () => ({
  readRuleAutomationIds: async (ruleId: string) => {
    const r = store.rules.find((x) => x.id === ruleId);
    return r && !(r.metadata.rule as Row).draft ? [r.automationId] : [];
  },
}));
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { applyPlaybookActivators } from "./playbook-activators.js";
import { createRuleGoverned } from "../rules/create.js";
import { updateRuleGoverned } from "../rules/update.js";

const PB = "pb-repurpose";
function setPlaybook(activators: unknown) {
  store.playbook = {
    id: PB,
    name: "Repurpose",
    workspaceId: "ws-1",
    subjectProfile: {
      profileSlug: "post",
      statusProperty: "post-status",
      activators,
    },
  };
}
const run = (agentUserId?: string) =>
  applyPlaybookActivators({ playbookId: PB, userId: "user-1", agentUserId });

beforeEach(() => {
  store.rules = [];
  store.offers = [];
  store.links = [];
  store.agentProposes = false;
  store.seq = 0;
  vi.mocked(createRuleGoverned).mockClear();
  vi.mocked(updateRuleGoverned).mockClear();
});

const TWO = [
  { on: "created", mode: "propose" },
  { on: "enters_status", status: "published", mode: "run" },
];

describe("applyPlaybookActivators", () => {
  it("compiles each activator through the rule door and links it as `activator`", async () => {
    setPlaybook(TWO);
    const res = await run();
    expect(res.outcomes.map((o) => [o.key, o.status])).toEqual([
      ["created", "created"],
      ["enters_status:published", "created"],
    ]);
    const calls = vi.mocked(createRuleGoverned).mock.calls.map((c) => c[0]);
    expect(calls[1]!.intent).toBe(
      'When a post enters "published", run "Repurpose" on it.'
    );
    // The seed namespaces the rule to THIS playbook's activator key.
    expect(calls[1]!.seed).toMatchObject({
      template: `playbook-activator:${PB}`,
      key: "enters_status:published",
    });
    expect(calls[1]!.scope).toEqual({ kind: "workspace", workspaceId: "ws-1" });
    expect(store.links).toEqual([
      { playbookId: PB, automationId: "auto-rule-1", role: "activator" },
      { playbookId: PB, automationId: "auto-rule-2", role: "activator" },
    ]);
  });

  it("a second pass (re-install / boot) creates and updates NOTHING", async () => {
    setPlaybook(TWO);
    await run();
    vi.mocked(createRuleGoverned).mockClear();
    const again = await run();
    expect(createRuleGoverned).not.toHaveBeenCalled();
    expect(updateRuleGoverned).not.toHaveBeenCalled();
    expect(again.outcomes.every((o) => o.status === "unchanged")).toBe(true);
    expect(store.rules).toHaveLength(2);
    expect(store.links).toHaveLength(2);
  });

  it("a REMOVED activator retires its rule (draft) and drops its link; re-adding re-activates it", async () => {
    setPlaybook(TWO);
    await run();
    setPlaybook([TWO[0]]);
    const res = await run();
    expect(res.outcomes).toContainEqual({
      key: "enters_status:published",
      status: "retired",
      ruleId: "rule-2",
    });
    expect(vi.mocked(updateRuleGoverned).mock.calls.at(-1)![0]).toMatchObject({
      ruleId: "rule-2",
      draft: true,
    });
    expect(store.links.map((l) => l.automationId)).toEqual(["auto-rule-1"]);

    setPlaybook(TWO);
    const back = await run();
    expect(back.outcomes).toContainEqual({
      key: "enters_status:published",
      status: "reactivated",
      ruleId: "rule-2",
    });
    expect(store.rules).toHaveLength(2); // re-activated, not duplicated
    expect(store.links).toHaveLength(2);
  });

  it("a changed mode UPDATES the rule in place (untouched by its owner)", async () => {
    setPlaybook(TWO);
    await run();
    setPlaybook([TWO[0], { ...TWO[1], mode: "propose" }]);
    const res = await run();
    expect(res.outcomes).toContainEqual({
      key: "enters_status:published",
      status: "updated",
      ruleId: "rule-2",
    });
    expect(store.rules).toHaveLength(2);
  });

  it("an OWNER-EDITED rule is kept, never overwritten", async () => {
    setPlaybook(TWO);
    await run();
    (store.rules[1]!.metadata.rule as Row).intent = "My own words.";
    vi.mocked(updateRuleGoverned).mockClear();
    const res = await run();
    expect(updateRuleGoverned).not.toHaveBeenCalled();
    expect(res.outcomes).toContainEqual({
      key: "enters_status:published",
      status: "kept",
      ruleId: "rule-2",
    });
  });

  it("an agent caller's offer is filed ONCE: a pending proposal is not re-offered", async () => {
    setPlaybook([TWO[0]]);
    store.agentProposes = true;
    const first = await run("agent-1");
    expect(first.outcomes[0]).toMatchObject({ status: "offered" });
    vi.mocked(createRuleGoverned).mockClear();
    const second = await run("agent-1");
    expect(createRuleGoverned).not.toHaveBeenCalled();
    expect(second.outcomes[0]).toMatchObject({
      status: "offered",
      reason: "already waiting for review",
    });
  });

  it("a stored list that does not parse retires NOTHING (corrupt is not empty)", async () => {
    setPlaybook(TWO);
    await run();
    setPlaybook([{ on: "enters_status" }]); // invalid: no status
    vi.mocked(updateRuleGoverned).mockClear();
    const res = await run();
    expect(res.status).toBe("invalid");
    expect(updateRuleGoverned).not.toHaveBeenCalled();
    expect(store.links).toHaveLength(2);
  });

  it("enters_status without statusProperty is refused by name, not compiled widened", async () => {
    store.playbook = {
      id: PB,
      name: "Repurpose",
      workspaceId: "ws-1",
      subjectProfile: { profileSlug: "post", activators: [TWO[1]] },
    };
    const res = await run();
    expect(createRuleGoverned).not.toHaveBeenCalled();
    expect(res.outcomes[0]).toMatchObject({ status: "denied" });
  });
});
