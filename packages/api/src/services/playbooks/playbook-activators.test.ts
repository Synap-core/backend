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
  profiles: Symbol("profiles"),
}));
const store = vi.hoisted(() => ({
  playbook: null as Row | null,
  rules: [] as Array<{ id: string; metadata: Row; automationId: string }>,
  offers: [] as Array<{ id: string; status: string }>,
  links: [] as Array<{
    playbookId: string;
    automationId: string;
    role: string;
  }>,
  agentProposes: false,
  seq: 0,
  /** The subject profile row(s) and its declared lifecycle property. */
  profileRows: [] as Row[],
  lifecycleProperty: null as string | null,
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
              : table === T.profiles
                ? store.profileRows
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
      // The per-playbook memory write: `jsonb_set(metadata, '{activatorRules}',
      // <json>)` — the fake applies the JSON value it carries.
      update: () => ({
        set: (v: { metadata?: { vals?: unknown[] } }) => ({
          where: async () => {
            const json = v.metadata?.vals?.find(
              (x) => typeof x === "string" && x.startsWith('{"template"')
            ) as string | undefined;
            if (json && store.playbook) {
              store.playbook.metadata = {
                ...((store.playbook.metadata as Row) ?? {}),
                activatorRules: JSON.parse(json),
              };
            }
          },
        }),
      }),
      insert: () => ({
        values: (v: {
          playbookId: string;
          automationId: string;
          role: string;
        }) => ({
          onConflictDoUpdate: async () => {
            const hit = store.links.find(
              (l) =>
                l.playbookId === v.playbookId &&
                l.automationId === v.automationId
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
    profiles: T.profiles,
    ProfileResolutionService: class {
      async getEffectiveLifecycle() {
        return store.lifecycleProperty
          ? { propertySlug: store.lifecycleProperty }
          : null;
      }
    },
    skills: T.skills,
    proposals: T.proposals,
    playbookAutomations: {
      playbookId: "pid",
      automationId: "aid",
      role: "role",
    },
    // The delete predicate: carry the kept automation ids to the fake.
    and: (...parts: unknown[]) => ({
      keep:
        (
          parts.find((p) => (p as { keep?: string[] })?.keep) as
            | {
                keep: string[];
              }
            | undefined
        )?.keep ?? [],
    }),
    notInArray: (_c: unknown, ids: string[]) => ({ keep: ids }),
    eq: () => ({}),
    inArray: () => ({}),
    drizzleSql: (_s: TemplateStringsArray, ...vals: unknown[]) => ({ vals }),
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

import {
  ACTIVATOR_COMPILE_VERSION,
  activatorRuleDecl,
  applyPlaybookActivators,
  workerEnablementKey,
  workerSeedTemplate,
} from "./playbook-activators.js";
import { templateRuleHash } from "../rules/template-rules.js";
import { toBackendTrigger } from "@synap-core/types/automations";
import { createRuleGoverned } from "../rules/create.js";
import { updateRuleGoverned } from "../rules/update.js";

const PB = "pb-repurpose";
/** Re-declare the playbook; its stored metadata (the memory) is kept. */
function setPlaybook(activators: unknown, status = "active") {
  store.playbook = {
    id: PB,
    name: "Repurpose",
    status,
    workspaceId: "ws-1",
    metadata: (store.playbook?.metadata as Row | undefined) ?? {},
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
  store.playbook = null;
  store.rules = [];
  store.offers = [];
  store.links = [];
  store.agentProposes = false;
  store.seq = 0;
  store.profileRows = [];
  store.lifecycleProperty = null;
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
      status: "active",
      workspaceId: "ws-1",
      metadata: {},
      subjectProfile: { profileSlug: "post", activators: [TWO[1]] },
    };
    const res = await run();
    expect(createRuleGoverned).not.toHaveBeenCalled();
    expect(res.outcomes[0]).toMatchObject({ status: "denied" });
  });
});

const ruleRow = (id: string) => store.rules.find((r) => r.id === id)!;
const isDraft = (id: string) =>
  (ruleRow(id).metadata.rule as Row).draft === true;

describe("only a LIVE playbook declares", () => {
  it("a DRAFT playbook (a duplicated copy, an agent's draft) creates no rule", async () => {
    setPlaybook(TWO, "draft");
    const res = await run();
    expect(createRuleGoverned).not.toHaveBeenCalled();
    expect(res.outcomes).toEqual([]);
    expect(store.links).toEqual([]);
  });

  it("ARCHIVING retires every activator rule; re-activating brings them back (no duplicates)", async () => {
    setPlaybook(TWO);
    await run();
    setPlaybook(TWO, "archived");
    const res = await run();
    expect(res.outcomes.map((o) => o.status)).toEqual(["retired", "retired"]);
    expect(isDraft("rule-1") && isDraft("rule-2")).toBe(true);
    expect(store.links).toEqual([]);

    setPlaybook(TWO, "active");
    const back = await run();
    expect(back.outcomes.map((o) => o.status)).toEqual([
      "reactivated",
      "reactivated",
    ]);
    expect(store.rules).toHaveLength(2);
  });

  it("a duplicate copy carrying its SOURCE's memory still creates its own rules", async () => {
    setPlaybook(TWO);
    store.playbook!.metadata = {
      activatorRules: {
        template: "playbook-activator:pb-source",
        rules: { created: { ruleId: "rule-of-source" } },
      },
    };
    const res = await run();
    expect(res.outcomes.map((o) => o.status)).toEqual(["created", "created"]);
  });
});

describe("the OWNER wins, on every later pass (boot included)", () => {
  it("a rule the owner PAUSED is never re-activated", async () => {
    setPlaybook(TWO);
    await run();
    (ruleRow("rule-2").metadata.rule as Row).draft = true; // skills.updateRule({draft:true})
    vi.mocked(updateRuleGoverned).mockClear();
    const res = await run();
    expect(updateRuleGoverned).not.toHaveBeenCalled();
    expect(isDraft("rule-2")).toBe(true);
    expect(res.outcomes).toContainEqual(
      expect.objectContaining({
        key: "enters_status:published",
        status: "owner_choice",
      })
    );
  });

  it("a rule the owner DELETED is never recreated", async () => {
    setPlaybook(TWO);
    await run();
    store.rules = store.rules.filter((r) => r.id !== "rule-2");
    vi.mocked(createRuleGoverned).mockClear();
    const res = await run();
    expect(createRuleGoverned).not.toHaveBeenCalled();
    expect(res.outcomes).toContainEqual(
      expect.objectContaining({
        key: "enters_status:published",
        status: "owner_choice",
      })
    );
  });
});

describe("concurrency", () => {
  it("two concurrent passes in one process create each rule ONCE", async () => {
    setPlaybook(TWO);
    await Promise.all([run(), run()]);
    expect(createRuleGoverned).toHaveBeenCalledTimes(2);
    expect(store.rules).toHaveLength(2);
  });

  it("a duplicate row of one key (a cross-process race) is retired, one is kept", async () => {
    setPlaybook([TWO[0]]);
    await run();
    // A second live row with the same seed, as a racing process would write.
    store.rules.push({
      id: "rule-dup",
      automationId: "auto-rule-dup",
      metadata: JSON.parse(JSON.stringify(ruleRow("rule-1").metadata)),
    });
    const res = await run();
    expect(isDraft("rule-dup")).toBe(true);
    expect(isDraft("rule-1")).toBe(false);
    expect(res.outcomes).toContainEqual(
      expect.objectContaining({ ruleId: "rule-dup", status: "retired" })
    );
  });
});

/**
 * E1 (work model L2): `enters_status` follows the event that actually fires.
 * A DECLARED lifecycle (kind or role) → the transition event, filtered on the
 * profile whose lifecycle moved; an undeclared KIND property → the property
 * change; an undeclared ROLE → refused by name (nothing would ever fire).
 */
describe("enters_status follows the transition event", () => {
  const triggerOf = (ruleId: string) => {
    const sentence = (ruleRow(ruleId).metadata.rule as Row).sentence as {
      trigger: Row;
      conditions: Array<Row>;
    };
    return sentence;
  };
  const ENTERS = [{ on: "enters_status", status: "published", mode: "run" }];

  it("a kind whose statusProperty IS its declared lifecycle compiles onto the transition", async () => {
    store.profileRows = [
      { id: "p-post", profileKind: "kind", workspaceId: null },
    ];
    store.lifecycleProperty = "post-status";
    setPlaybook(ENTERS);
    const res = await run();
    expect(res.outcomes[0]).toMatchObject({ status: "created" });
    const s = triggerOf(res.outcomes[0]!.ruleId!);
    expect(s.trigger).toMatchObject({
      actionVerb: "transitioned",
      profileSlug: "post",
    });
    expect(s.conditions).toEqual([
      { id: "activator-status", key: "to", operator: "is", value: "published" },
    ]);
  });

  it("a ROLE with a declared lifecycle compiles onto the transition (roles were blind)", async () => {
    store.profileRows = [
      { id: "p-client", profileKind: "role", workspaceId: null },
    ];
    store.lifecycleProperty = "post-status";
    setPlaybook(ENTERS);
    const res = await run();
    expect(res.outcomes[0]).toMatchObject({ status: "created" });
    expect(triggerOf(res.outcomes[0]!.ruleId!).trigger).toMatchObject({
      actionVerb: "transitioned",
    });
  });

  it("a ROLE with NO declared lifecycle is refused by name — nothing would fire", async () => {
    store.profileRows = [
      { id: "p-client", profileKind: "role", workspaceId: null },
    ];
    setPlaybook(ENTERS);
    const res = await run();
    expect(createRuleGoverned).not.toHaveBeenCalled();
    expect(res.outcomes[0]).toMatchObject({ status: "denied" });
    expect(res.outcomes[0]!.reason).toContain("no declared lifecycle");
  });

  it("an undeclared KIND property keeps the property-change compile (the event that fires)", async () => {
    store.profileRows = [
      { id: "p-post", profileKind: "kind", workspaceId: null },
    ];
    setPlaybook(ENTERS);
    const res = await run();
    expect(triggerOf(res.outcomes[0]!.ruleId!).trigger).toMatchObject({
      actionVerb: "updated",
    });
  });

  it("declaring the lifecycle LATER recompiles the untouched rule in place (the convergence)", async () => {
    store.profileRows = [
      { id: "p-post", profileKind: "kind", workspaceId: null },
    ];
    setPlaybook(ENTERS);
    const first = await run();
    const ruleId = first.outcomes[0]!.ruleId!;
    expect(triggerOf(ruleId).trigger).toMatchObject({ actionVerb: "updated" });
    store.lifecycleProperty = "post-status";
    const second = await run();
    expect(second.outcomes[0]).toMatchObject({ status: "updated", ruleId });
    expect(triggerOf(ruleId).trigger).toMatchObject({
      actionVerb: "transitioned",
    });
    expect(createRuleGoverned).toHaveBeenCalledTimes(1);
  });

  it("a playbook with no statusProperty follows the profile's declared lifecycle", async () => {
    store.profileRows = [
      { id: "p-post", profileKind: "kind", workspaceId: null },
    ];
    store.lifecycleProperty = "post-status";
    store.playbook = {
      id: PB,
      name: "Repurpose",
      status: "active",
      workspaceId: "ws-1",
      metadata: {},
      subjectProfile: { profileSlug: "post", activators: ENTERS },
    };
    const res = await run();
    expect(res.outcomes[0]).toMatchObject({ status: "created" });
  });
});

/**
 * R1 — a process on a ROLE (`lead`, `client`). Driven from the real activator
 * compile through the real sentence → trigger converter to the stored
 * `triggerConfig` the matcher reads: nothing hand-built in between.
 */
describe("a ROLE subject (R1)", () => {
  function setLeadPlaybook(activators: unknown) {
    store.playbook = {
      id: PB,
      name: "Qualify a lead",
      status: "active",
      workspaceId: "ws-1",
      metadata: (store.playbook?.metadata as Row | undefined) ?? {},
      subjectProfile: {
        profileSlug: "lead",
        statusProperty: "leadStage",
        activators,
      },
    };
  }
  const compiled = (ruleId: string) => {
    const sentence = (ruleRow(ruleId).metadata.rule as Row).sentence as {
      trigger: Parameters<typeof toBackendTrigger>[0];
      conditions: Parameters<typeof toBackendTrigger>[1];
    };
    return toBackendTrigger(sentence.trigger, sentence.conditions)
      .triggerConfig;
  };
  const CREATED = [{ on: "created", mode: "propose" }];

  it("`created` on a role fires when the role is ATTACHED (the facet event), filtered on the role", async () => {
    store.profileRows = [
      { id: "p-lead", profileKind: "role", workspaceId: null },
    ];
    store.lifecycleProperty = "leadStage";
    setLeadPlaybook(CREATED);
    const res = await run();
    expect(res.outcomes[0]).toMatchObject({ status: "created" });
    expect(compiled(res.outcomes[0]!.ruleId!)).toEqual({
      eventPattern: "entity_facet.attach.completed",
      filters: { profileSlug: "lead" },
    });
  });

  it("a role rule compiled BEFORE R1 (onto entity.create) recompiles in place — never a second rule", async () => {
    // The pod did not know `lead` was a role at the first pass: the old
    // compile, onto the kind's create event (which never names a role).
    setLeadPlaybook(CREATED);
    const first = await run();
    const ruleId = first.outcomes[0]!.ruleId!;
    expect(compiled(ruleId).eventPattern).toBe("entity.create.completed");
    store.profileRows = [
      { id: "p-lead", profileKind: "role", workspaceId: null },
    ];
    const second = await run();
    expect(second.outcomes[0]).toMatchObject({ status: "updated", ruleId });
    expect(compiled(ruleId).eventPattern).toBe("entity_facet.attach.completed");
    expect(createRuleGoverned).toHaveBeenCalledTimes(1);
  });

  it("a COUNT worker on a role follows the role's transition; its spec names the role", async () => {
    store.profileRows = [
      { id: "p-lead", profileKind: "role", workspaceId: null },
    ];
    store.lifecycleProperty = "leadStage";
    setLeadPlaybook([
      { on: "count", status: "qualified", min: 5, mode: "run" },
    ]);
    const res = await run();
    const ruleId = res.outcomes[0]!.ruleId!;
    expect(compiled(ruleId)).toEqual({
      eventPattern: "entity.transition.completed",
      filters: { lifecycleProfile: "lead", to: "qualified" },
    });
    const config = (
      (ruleRow(ruleId).metadata.rule as Row).sentence as {
        actions: Array<{ config: Record<string, unknown> }>;
      }
    ).actions[0]!.config;
    expect(config.__worker).toMatchObject({
      profileSlug: "lead",
      status: "qualified",
      minCount: 5,
      size: "per_moment",
    });
  });

  it("a COUNT on a role with NO declared lifecycle is refused by name, like enters_status", async () => {
    store.profileRows = [
      { id: "p-lead", profileKind: "role", workspaceId: null },
    ];
    store.lifecycleProperty = null;
    setLeadPlaybook([
      { on: "count", status: "qualified", min: 5, mode: "run" },
    ]);
    const res = await run();
    expect(res.outcomes[0]).toMatchObject({ status: "denied" });
    expect(createRuleGoverned).not.toHaveBeenCalled();
  });

  it("a SCHEDULE worker on a role compiles to a cron rule whose spec reads the role's set", async () => {
    store.profileRows = [
      { id: "p-lead", profileKind: "role", workspaceId: null },
    ];
    store.lifecycleProperty = "leadStage";
    setLeadPlaybook([
      { on: "schedule", cron: "0 9 * * 1", status: "engaged", mode: "propose" },
    ]);
    const res = await run();
    const ruleId = res.outcomes[0]!.ruleId!;
    const sentence = (ruleRow(ruleId).metadata.rule as Row).sentence as {
      trigger: Parameters<typeof toBackendTrigger>[0];
      conditions: Parameters<typeof toBackendTrigger>[1];
      actions: Array<{ config: Record<string, unknown> }>;
    };
    const trigger = toBackendTrigger(sentence.trigger, sentence.conditions);
    expect(trigger.triggerType).toBe("cron");
    expect(trigger.triggerConfig).toMatchObject({ expression: "0 9 * * 1" });
    expect(sentence.actions[0]!.config.__worker).toMatchObject({
      profileSlug: "lead",
      status: "engaged",
      size: "per_moment",
      writes: "propose",
    });
  });

  it("`enters_status` on a role follows the role's TRANSITION, filtered on the role, not the kind", async () => {
    store.profileRows = [
      { id: "p-lead", profileKind: "role", workspaceId: null },
    ];
    store.lifecycleProperty = "leadStage";
    setLeadPlaybook([
      { on: "enters_status", status: "qualified", mode: "run" },
    ]);
    const res = await run();
    expect(res.outcomes[0]).toMatchObject({ status: "created" });
    expect(compiled(res.outcomes[0]!.ruleId!)).toEqual({
      eventPattern: "entity.transition.completed",
      filters: { lifecycleProfile: "lead", to: "qualified" },
    });
  });
});

describe("stage workers (work model L4)", () => {
  const configOf = (call: number) =>
    (
      vi.mocked(createRuleGoverned).mock.calls[call]![0].sentence as {
        actions: Array<{ config: Record<string, unknown> }>;
      }
    ).actions[0]!.config;

  it("a COUNT worker compiles per_moment: the node runs, its writes propose, the threshold rides on the spec", async () => {
    store.lifecycleProperty = "post-status";
    setPlaybook([{ on: "count", status: "review", min: 3, mode: "propose" }]);
    const res = await run();
    expect(res.outcomes).toEqual([
      { key: "count:review", status: "created", ruleId: "rule-1" },
    ]);
    const config = configOf(0);
    expect(config.__worker).toEqual({
      key: "count:review",
      size: "per_moment",
      profileSlug: "post",
      status: "review",
      minCount: 3,
      writes: "propose",
    });
    // A batch RUNS; proposing is the writes' job, not the node's.
    expect(config).not.toHaveProperty("__mode");
  });

  it("D4: a plain created / enters_status activator carries the worker spec too", async () => {
    setPlaybook(TWO);
    await run();
    expect(configOf(0).__worker).toEqual({
      key: "created",
      size: "per_thing",
      profileSlug: "post",
    });
    expect(configOf(1).__worker).toEqual({
      key: "enters_status:published",
      size: "per_thing",
      profileSlug: "post",
      status: "published",
    });
  });

  it("a MANUAL worker compiles no rule", async () => {
    setPlaybook([{ on: "manual", mode: "run" }]);
    const res = await run();
    expect(createRuleGoverned).not.toHaveBeenCalled();
    expect(res.outcomes[0]).toMatchObject({
      key: "manual",
      status: "unchanged",
    });
  });

  /** What `workers.enable` writes for a project: the worker namespace. */
  async function enableForProject(projectId: string) {
    const decl = activatorRuleDecl({
      activator: TWO[1] as never,
      playbookId: PB,
      playbookName: "Repurpose",
      profileSlug: "post",
      statusProperty: "post-status",
      subject: { profileKind: "kind", lifecycleProperty: null },
      scope: { projectId },
    }) as { key: string; intent: string; sentence: unknown };
    await createRuleGoverned({
      userId: "user-1",
      intent: decl.intent,
      scope: { kind: "workspace", workspaceId: "ws-1", projectId },
      sentence: decl.sentence,
      seed: {
        template: workerSeedTemplate(PB),
        key: workerEnablementKey({
          activatorKey: "enters_status:published",
          projectId,
        }),
        hash: templateRuleHash(decl),
      },
    });
    vi.mocked(createRuleGoverned).mockClear();
    return store.rules.at(-1)!;
  }

  it("a PROJECT enablement compiles with its filing + spec, follows its declaration, and is linked while live", async () => {
    setPlaybook(TWO);
    await run();
    const rule = await enableForProject("proj-1");
    const config = (
      (rule.metadata.rule as Row).sentence as {
        actions: Array<{ config: Record<string, unknown> }>;
      }
    ).actions[0]!.config;
    expect(config.__projectId).toBe("proj-1");
    expect(config.__worker).toMatchObject({
      key: "enters_status:published",
      size: "per_thing",
    });
    expect((rule.metadata.rule as Row).intent).toBe(
      'When a post enters "published" in this project, run "Repurpose" on it.'
    );

    const pass = await run();
    expect(pass.outcomes).toContainEqual({
      key: "enters_status:published@project:proj-1",
      status: "unchanged",
      ruleId: rule.id,
    });
    expect(store.links.map((l) => l.automationId)).toContain(rule.automationId);

    // Undeclared → retired by us, unlinked; declared again → back.
    setPlaybook([TWO[0]]);
    const gone = await run();
    expect(gone.outcomes).toContainEqual({
      key: "enters_status:published@project:proj-1",
      status: "retired",
      ruleId: rule.id,
    });
    expect(store.links.map((l) => l.automationId)).not.toContain(
      rule.automationId
    );
    setPlaybook(TWO);
    const back = await run();
    expect(back.outcomes).toContainEqual({
      key: "enters_status:published@project:proj-1",
      status: "reactivated",
      ruleId: rule.id,
    });
    expect(createRuleGoverned).not.toHaveBeenCalled(); // never created here
  });

  it("a project enablement a PERSON disabled stays off on every later pass", async () => {
    setPlaybook(TWO);
    await run();
    const rule = await enableForProject("proj-1");
    (rule.metadata.rule as Row).draft = true; // workers.setPaused(paused: true)
    const pass = await run();
    expect(pass.outcomes).toContainEqual({
      key: "enters_status:published@project:proj-1",
      status: "owner_choice",
      ruleId: rule.id,
      reason: "disabled by a person — left off",
    });
    expect((rule.metadata.rule as Row).draft).toBe(true);
  });
});

/**
 * D4 — the compile version. An installed rule compiled before every activator
 * carried the worker spec (compile version 1) re-converges ONCE, through the
 * same three-way as any pass. Rows rule out: an untouched v1 rule left
 * without its spec; an owner-EDITED v1 rule rewritten; a PAUSED one armed or
 * recompiled; a DELETED one recreated; a version stamped by a pass that did
 * not converge.
 */
describe("D4: rules compiled before the worker spec re-converge once", () => {
  /** The decl as compile version 1 wrote it: no `__worker` on the node. */
  function v1Decl(activator: Row) {
    const decl = activatorRuleDecl({
      activator: activator as never,
      playbookId: PB,
      playbookName: "Repurpose",
      profileSlug: "post",
      statusProperty: "post-status",
      subject: { profileKind: "kind", lifecycleProperty: null },
    }) as { key: string; intent: string; sentence: Row };
    const sentence = JSON.parse(JSON.stringify(decl.sentence)) as {
      actions: Array<{ config: Row }>;
    };
    delete sentence.actions[0]!.config.__worker;
    return { key: decl.key, intent: decl.intent, sentence };
  }
  /** An installed v1 rule + the playbook's memory of it (no version). */
  function installV1(activator: Row, edit?: (rule: Row) => void) {
    const d = v1Decl(activator);
    const id = `rule-v1-${++store.seq}`;
    const rule: Row = {
      v: 1,
      intent: d.intent,
      scope: { kind: "workspace", workspaceId: "ws-1" },
      sentence: d.sentence,
      seed: {
        template: `playbook-activator:${PB}`,
        key: d.key,
        hash: templateRuleHash(d),
      },
      behaviours: [],
    };
    edit?.(rule);
    store.rules.push({ id, automationId: `auto-${id}`, metadata: { rule } });
    return { id, key: d.key };
  }
  function remember(rules: Record<string, { ruleId: string }>) {
    store.playbook!.metadata = {
      activatorRules: { template: `playbook-activator:${PB}`, rules },
    };
  }
  const memory = () =>
    (store.playbook!.metadata as Row).activatorRules as {
      compileVersion?: number;
    };

  it("an untouched v1 rule is recompiled with the spec, once; the version is stamped", async () => {
    setPlaybook(TWO);
    const a = installV1(TWO[0]!);
    const b = installV1(TWO[1]!);
    remember({ [a.key]: { ruleId: a.id }, [b.key]: { ruleId: b.id } });
    expect(ACTIVATOR_COMPILE_VERSION).toBe(2);

    const first = await run();
    expect(first.outcomes.map((o) => o.status)).toEqual(["updated", "updated"]);
    for (const id of [a.id, b.id]) {
      const rule = store.rules.find((r) => r.id === id)!.metadata.rule as {
        sentence: { actions: Array<{ config: Row }> };
      };
      expect(rule.sentence.actions[0]!.config.__worker).toBeDefined();
    }
    expect(memory().compileVersion).toBe(2);
    expect(createRuleGoverned).not.toHaveBeenCalled();

    vi.mocked(updateRuleGoverned).mockClear();
    const second = await run();
    expect(updateRuleGoverned).not.toHaveBeenCalled();
    expect(second.outcomes.every((o) => o.status === "unchanged")).toBe(true);
  });

  it("an owner-EDITED v1 rule is kept as the owner left it", async () => {
    setPlaybook([TWO[1]!]);
    const e = installV1(TWO[1]!, (rule) => {
      rule.intent = "When a post is published, tell me first.";
    });
    remember({ [e.key]: { ruleId: e.id } });
    const res = await run();
    expect(res.outcomes[0]).toMatchObject({ key: e.key, ruleId: e.id });
    expect(["kept", "conflict"]).toContain(res.outcomes[0]!.status);
    expect(updateRuleGoverned).not.toHaveBeenCalled();
    const rule = store.rules[0]!.metadata.rule as {
      intent: string;
      sentence: { actions: Array<{ config: Row }> };
    };
    expect(rule.intent).toBe("When a post is published, tell me first.");
    expect(rule.sentence.actions[0]!.config.__worker).toBeUndefined();
  });

  it("a PAUSED v1 rule stays paused and uncompiled; a DELETED one is not recreated", async () => {
    setPlaybook(TWO);
    const paused = installV1(TWO[0]!, (rule) => {
      rule.draft = true;
    });
    remember({
      [paused.key]: { ruleId: paused.id },
      "enters_status:published": { ruleId: "rule-gone" },
    });
    const res = await run();
    expect(res.outcomes.map((o) => [o.key, o.status])).toEqual([
      ["created", "owner_choice"],
      ["enters_status:published", "owner_choice"],
    ]);
    expect(updateRuleGoverned).not.toHaveBeenCalled();
    expect(createRuleGoverned).not.toHaveBeenCalled();
    const rule = store.rules[0]!.metadata.rule as Row;
    expect(rule.draft).toBe(true);
  });

  it("a pass that did not converge stamps no version", async () => {
    // An enters_status activator with no status property anywhere: denied.
    store.playbook = {
      id: PB,
      name: "Repurpose",
      status: "active",
      workspaceId: "ws-1",
      metadata: {},
      subjectProfile: {
        profileSlug: "post",
        activators: [{ on: "enters_status", status: "published", mode: "run" }],
      },
    };
    const res = await run();
    expect(res.outcomes[0]!.status).toBe("denied");
    expect(
      ((store.playbook!.metadata as Row).activatorRules as Row | undefined)
        ?.compileVersion
    ).toBeUndefined();
  });
});
