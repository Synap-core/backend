/**
 * `updateRuleGoverned` — the edit door, and the activation door.
 *
 * Three properties are worth a test here, and they are the three that were
 * impossible before this door existed:
 *
 *  1. AN EDIT DOES NOT LOSE THE RULE. Before, editing meant delete-and-recreate:
 *     a new id, lost run history, lost lineage. So these tests assert the rule
 *     id survives and the AUTOMATION id survives — the automation is updated in
 *     place through the automations router's own door, which is what keeps
 *     `automation_runs` pointing at the same behaviour.
 *  2. `diverged` IS CLEARED BY RE-EARNING IT. The snapshot is re-hashed AFTER
 *     the automation has been rewritten from the rule's own sentence, never
 *     stamped from whatever the automation happened to contain. A marker
 *     asserting a convergence that never ran is the durable-lie class named in
 *     `.claude/rules/backend-rules.md`.
 *  3. ACTIVATION IS A RECOMPILE, NOT A FLIP. Turning `draft: false` runs the
 *     compiler and refuses by clause. There is no code path that arms a rule
 *     without passing it. (The exhaustive per-operator version of that property
 *     lives in `draft-fails-closed.test.ts`, which iterates the exported
 *     constant so a fourth unevaluable operator inherits the coverage.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const RULE_ID = "11111111-1111-1111-1111-111111111111";
const AUTOMATION_ID = "22222222-2222-2222-2222-222222222222";

/** The stored rule row the door loads. Mutated per-test. */
let storedRow: Record<string, unknown> | undefined;
/** The automations `readRuleAutomationIds` resolves off the `activates` edge. */
let linkedAutomationIds: string[] = [];
/** The rows the door reads back for those ids. */
let automationRows: Array<Record<string, unknown>> = [];

const skillUpdates: Array<Record<string, unknown>> = [];
const automationUpdates: Array<Record<string, unknown>> = [];
const linkCalls: Array<Record<string, unknown>> = [];
const unlinkedIds: string[] = [];

/**
 * PARTIAL mock (`importOriginal`), never a total replacement — see
 * `__tripwires__/database-mock-total-ratchet.test.ts`: a hand-listed module
 * object takes the WHOLE FILE dark, silently, the moment a file in the import
 * graph uses an export it does not list.
 *
 * Because the REAL drizzle tables are in play, the write target is discriminated
 * by table IDENTITY against `actual.skills` — not by a `__table` string a fake
 * object carried. Identity is the thing that cannot drift.
 */
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: { skills: { findFirst: async () => storedRow } },
      select: () => ({ from: () => ({ where: async () => automationRows }) }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            if (table === actual.skills) skillUpdates.push(values);
            else automationUpdates.push(values);
          },
        }),
      }),
      delete: () => ({ where: async () => undefined }),
      insert: () => ({
        values: () => ({ returning: async () => [{ id: RULE_ID }] }),
      }),
    },
  };
});

let permResult: Record<string, unknown> = { allowed: true };
const gateCalls: Array<Record<string, unknown>> = [];
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (args: Record<string, unknown>) => {
    gateCalls.push(args);
    return permResult;
  },
}));

vi.mock("../skills/visibility.js", () => ({
  visibleSkillsWhere: () => ({}),
}));

vi.mock("./lineage.js", () => ({
  readRuleAutomationIds: async () => linkedAutomationIds,
}));

vi.mock("./index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index.js")>();
  return {
    ...actual,
    linkRuleHalves: async (args: Record<string, unknown>) => {
      linkCalls.push(args);
    },
    unlinkRuleBehaviours: async (args: { automationIds: string[] }) => {
      unlinkedIds.push(...args.automationIds);
    },
  };
});

/**
 * `snapshotBehaviours` lives in `create.js` and hashes real automation rows.
 * Left UNMOCKED on purpose: property 2 above is about the snapshot being
 * re-derived, and mocking the thing that derives it would test nothing.
 */

const materializeCalls: Array<Record<string, unknown>> = [];
let updateThrows: Error | null = null;
vi.mock("../../routers/automations.js", () => ({
  materializeAutomationForPrincipal: async (args: Record<string, unknown>) => {
    materializeCalls.push(args);
    return "44444444-4444-4444-4444-444444444444";
  },
  automationsRouter: {
    createCaller: () => ({
      update: async (args: Record<string, unknown>) => {
        if (updateThrows) throw updateThrows;
        automationUpdates.push({ viaRouter: true, ...args });
        return { id: args.id };
      },
    }),
  },
}));

const { updateRuleGoverned } = await import("./update.js");
const { buildRuleMetadata, readRuleMetadata, RULE_METADATA_KEY } =
  await import("./index.js");

const GOOD_SENTENCE = {
  trigger: {
    triggerType: "event" as const,
    subjectCategory: "entity" as const,
    actionVerb: "created" as const,
  },
  conditions: [],
  actions: [{ type: "notify" as const, config: { message: "hi" } }],
};

/**
 * A sentence the runtime CANNOT evaluate, so activating it would produce a rule
 * that saves green and never fires.
 *
 * ⚠️ THE FIXTURE WENT STALE, NOT THE RULE. This used `operator: "contains"`,
 * which was refused by name until the matcher gained `$contains`. Once it
 * became evaluable this stopped being a holed sentence at all, and the two
 * tests below started failing while asserting a property that is still
 * completely correct — activation must refuse an un-runnable rule.
 *
 * `changed_to` is now the ONLY operator still refused, and unlike the other two
 * it is not an omission: it asks "did this field BECOME x", which needs the
 * value before the event, and the matcher is handed one payload. So it is the
 * durable choice here rather than the next one to expire.
 */
const BAD_WHERE = {
  ...GOOD_SENTENCE,
  conditions: [
    {
      id: "c1",
      key: "status",
      operator: "changed_to",
      value: "open",
    } as unknown as never,
  ],
};

const ORIGINAL_CREATED_AT = "2020-01-01T00:00:00.000Z";

const rowWith = (over: Record<string, unknown> = {}) => ({
  id: RULE_ID,
  metadata: {
    [RULE_METADATA_KEY]: {
      ...buildRuleMetadata({
        intent: "original prose",
        scope: { kind: "pod" as const },
        behaviours: [{ automationId: AUTOMATION_ID, flowHash: "stale-hash" }],
      }),
      createdAt: ORIGINAL_CREATED_AT,
      ...over,
    },
  },
});

const update = (over: Record<string, unknown> = {}) =>
  updateRuleGoverned({
    userId: "user-1",
    ruleId: RULE_ID,
    workspaceId: "ws-1",
    intent: "When an entity is created, notify me",
    scope: { kind: "pod" },
    ...over,
  } as Parameters<typeof updateRuleGoverned>[0]);

const lastRuleMetadata = () =>
  readRuleMetadata(
    (skillUpdates.at(-1)?.metadata ?? {}) as Record<string, unknown>
  );

beforeEach(() => {
  storedRow = rowWith();
  linkedAutomationIds = [AUTOMATION_ID];
  automationRows = [
    {
      id: AUTOMATION_ID,
      workspaceId: null,
      metadata: { ruleId: RULE_ID, kind: "rule" },
      flowDefinition: { nodes: [], edges: [] },
    },
  ];
  skillUpdates.length = 0;
  automationUpdates.length = 0;
  linkCalls.length = 0;
  unlinkedIds.length = 0;
  materializeCalls.length = 0;
  gateCalls.length = 0;
  permResult = { allowed: true };
  updateThrows = null;
});

describe("the rule survives its own edit", () => {
  it("keeps the rule id — an edit is not a delete-and-recreate", async () => {
    const result = await update({ sentence: GOOD_SENTENCE });
    expect(result).toMatchObject({ status: "updated", ruleId: RULE_ID });
  });

  it("UPDATES the existing automation in place, keeping its id", async () => {
    const result = await update({ sentence: GOOD_SENTENCE });
    // Through the automations router's OWN door — so the rule inherits that
    // door's event-pattern check, filter-operator gate, flow validation and
    // version bump with no second implementation.
    expect(automationUpdates.at(-1)).toMatchObject({
      viaRouter: true,
      id: AUTOMATION_ID,
    });
    // Nothing was created: creating a replacement is what loses the run history.
    expect(materializeCalls).toHaveLength(0);
    expect(result).toMatchObject({ automationIds: [AUTOMATION_ID] });
  });

  it("does NOT reset the rule's birthday", async () => {
    // `buildRuleMetadata` stamps `now`, which would silently move `createdAt`
    // forward on every save and make a rule look newly written each time it was
    // edited.
    await update({ sentence: GOOD_SENTENCE });
    expect(lastRuleMetadata()?.createdAt).toBe(ORIGINAL_CREATED_AT);
  });

  it("rewrites the prose in body/description, not only in metadata", async () => {
    // The rule's intent IS the fact an agent reads while reasoning — that is why
    // a rule lives in `skills` at all. An edit that changed only the JSONB would
    // leave every agent reading the OLD instruction.
    await update({ intent: "New prose", sentence: GOOD_SENTENCE });
    expect(skillUpdates.at(-1)).toMatchObject({
      body: "New prose",
      description: "New prose",
    });
    expect(lastRuleMetadata()?.intent).toBe("New prose");
  });
});

describe("divergence is cleared by RE-EARNING the snapshot", () => {
  it("re-hashes after the rewrite instead of keeping the stale hash", async () => {
    await update({ sentence: GOOD_SENTENCE });
    const behaviours = lastRuleMetadata()?.behaviours ?? [];
    expect(behaviours).toHaveLength(1);
    expect(behaviours[0]?.automationId).toBe(AUTOMATION_ID);
    // The stored hash was "stale-hash"; the new one is a real sha256 of the
    // automation's flow as it now stands. Asserting only "it changed" would
    // pass for a stamped constant, so assert the SHAPE of a real hash too.
    expect(behaviours[0]?.flowHash).not.toBe("stale-hash");
    expect(behaviours[0]?.flowHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("activation is a recompile, never a flip", () => {
  it("REFUSES to activate a rule whose WHERE still has a hole", async () => {
    const result = await update({ draft: false, sentence: BAD_WHERE });
    expect(result).toMatchObject({
      status: "denied",
      failure: { clause: "WHERE" },
    });
    // Refused BEFORE the gate — an un-runnable rule must not cost the owner a
    // proposal to review.
    expect(gateCalls).toHaveLength(0);
    // And nothing was written.
    expect(skillUpdates).toHaveLength(0);
    expect(automationUpdates).toHaveLength(0);
  });

  it("SAVES the same holed sentence when it stays a draft", async () => {
    const result = await update({ draft: true, sentence: BAD_WHERE });
    expect(result).toMatchObject({ status: "updated", draft: true });
    expect(lastRuleMetadata()?.draft).toBe(true);
  });

  it("ARCHIVES the automation when a live rule is returned to draft", async () => {
    // The interlock again, from the other direction: a draft must have no
    // firing artifact, so demoting a live rule retires the automation rather
    // than leaving it around at some other status.
    const result = await update({ draft: true, sentence: BAD_WHERE });
    expect(automationUpdates.at(-1)).toMatchObject({ status: "archived" });
    // …and the membership edge goes with it. An archived automation still named
    // by the `activates` edge would read as a permanent `"missing"` divergence
    // on a rule that is actually fine.
    expect(unlinkedIds).toContain(AUTOMATION_ID);
    expect(result).toMatchObject({ automationIds: [] });
  });
});

describe("the governance gate", () => {
  it("files under the rule/update door, not skill/update", async () => {
    await update({ sentence: GOOD_SENTENCE });
    expect(gateCalls.at(-1)).toMatchObject({
      subjectType: "rule",
      action: "update",
    });
  });

  it("carries the FULL edit in the payload so approval reproduces it", async () => {
    await update({ sentence: GOOD_SENTENCE, draft: true });
    expect(gateCalls.at(-1)?.data).toMatchObject({
      id: RULE_ID,
      intent: "When an entity is created, notify me",
      scope: { kind: "pod" },
      draft: true,
      sentence: GOOD_SENTENCE,
    });
  });

  it("returns `proposed` without writing anything", async () => {
    permResult = { proposalId: "prop-1" };
    const result = await update({ sentence: GOOD_SENTENCE });
    expect(result).toMatchObject({ status: "proposed", proposalId: "prop-1" });
    expect(skillUpdates).toHaveLength(0);
    expect(automationUpdates).toHaveLength(0);
  });
});

describe("the SENTENCE has THREE states", () => {
  // The first cut of this door had only two, and the miss destroyed data:
  // `sentence` is optional on the wire, so a caller editing ONLY the prose sent
  // none, the door compiled nothing, and the archive branch retired the rule's
  // automation. A rule lost its behaviour because its author changed one word
  // of its description.
  const storedRowWithSentence = () => rowWith({ sentence: GOOD_SENTENCE });

  it("ABSENT carries the STORED sentence forward and recompiles it", async () => {
    storedRow = storedRowWithSentence();
    const result = await update({ intent: "Only the prose changed" });
    expect(result).toMatchObject({ status: "updated" });
    // The behaviour survives: the existing automation was rewritten, not retired.
    expect(automationUpdates.at(-1)).toMatchObject({
      viaRouter: true,
      id: AUTOMATION_ID,
    });
    expect(unlinkedIds).not.toContain(AUTOMATION_ID);
    expect(result).toMatchObject({ automationIds: [AUTOMATION_ID] });
    // …and the sentence is still stored, so the rule stays replayable.
    expect(lastRuleMetadata()?.sentence).toMatchObject({
      actions: [{ type: "notify" }],
    });
  });

  it("null REMOVES the behaviour — the rule becomes prose-only", async () => {
    storedRow = storedRowWithSentence();
    const result = await update({ sentence: null });
    expect(automationUpdates.at(-1)).toMatchObject({ status: "archived" });
    expect(unlinkedIds).toContain(AUTOMATION_ID);
    expect(result).toMatchObject({ automationIds: [] });
    expect(lastRuleMetadata()?.sentence).toBeUndefined();
    // The removal must be its OWN signal in the payload, or an approval would
    // fall back to "carry the stored sentence forward" and restore what the
    // reviewer approved deleting.
    expect(gateCalls.at(-1)?.data).toMatchObject({ clearSentence: true });
  });

  it("a sentence REPLACES the behaviour", async () => {
    storedRow = storedRowWithSentence();
    await update({ sentence: GOOD_SENTENCE });
    expect(automationUpdates.at(-1)).toMatchObject({ id: AUTOMATION_ID });
    expect(unlinkedIds).toHaveLength(0);
  });

  it("carrying forward a HOLED stored sentence still refuses to activate", async () => {
    // The carry-forward must not become a bypass: a draft whose stored sentence
    // has a hole, edited without mentioning the sentence and with draft:false,
    // is an ACTIVATION and has to be refused by clause like any other.
    storedRow = rowWith({ sentence: BAD_WHERE, draft: true });
    const result = await update({ draft: false });
    expect(result).toMatchObject({
      status: "denied",
      failure: { clause: "WHERE" },
    });
  });
});

describe("the review date has THREE states", () => {
  it("ABSENT leaves the stored date alone", async () => {
    storedRow = rowWith({ expiresAt: "2030-01-01T00:00:00.000Z" });
    await update({ sentence: GOOD_SENTENCE });
    expect(lastRuleMetadata()?.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("null CLEARS it", async () => {
    storedRow = rowWith({ expiresAt: "2030-01-01T00:00:00.000Z" });
    await update({ sentence: GOOD_SENTENCE, expiresAt: null });
    expect(lastRuleMetadata()?.expiresAt).toBeUndefined();
    // The CLEAR must survive into the proposal payload as its own signal —
    // otherwise an approved edit silently reverts to "leave it alone".
    expect(gateCalls.at(-1)?.data).toMatchObject({ clearExpiresAt: true });
  });

  it("a date SETS it", async () => {
    await update({
      sentence: GOOD_SENTENCE,
      expiresAt: "2031-06-01T00:00:00.000Z",
    });
    expect(lastRuleMetadata()?.expiresAt).toBe("2031-06-01T00:00:00.000Z");
  });
});

describe("refusals and misses", () => {
  it("reports not_found rather than creating a second rule", async () => {
    storedRow = undefined;
    const result = await update({ sentence: GOOD_SENTENCE });
    expect(result).toEqual({ status: "not_found" });
    expect(materializeCalls).toHaveLength(0);
  });

  it("refuses a skills row that is not a rule", async () => {
    storedRow = { id: RULE_ID, metadata: {} };
    const result = await update({ sentence: GOOD_SENTENCE });
    expect(result.status).toBe("denied");
  });

  it("refuses — and writes NOTHING — when the automation door rejects", async () => {
    // The door validates against the live catalog: checks the pure compiler
    // cannot make. A failure there means the edited rule cannot run, so the rule
    // must keep the sentence and the behaviour it already had.
    updateThrows = new Error("command no longer exists");
    const result = await update({ sentence: GOOD_SENTENCE });
    expect(result).toMatchObject({
      status: "denied",
      failure: { clause: "THEN" },
    });
    expect(skillUpdates).toHaveLength(0);
  });

  it("never rewrites an automation the author merely ATTACHED", async () => {
    // Only automations stamped with this rule's `metadata.ruleId` are the
    // rule's own behaviour. One the author linked by hand belongs to them.
    const ATTACHED = "55555555-5555-5555-5555-555555555555";
    linkedAutomationIds = [ATTACHED];
    automationRows = [
      {
        id: ATTACHED,
        workspaceId: null,
        metadata: { kind: "rule" },
        flowDefinition: { nodes: [], edges: [] },
      },
    ];
    const result = await update({ draft: true, sentence: BAD_WHERE });
    // Not archived, not unlinked, still a member.
    expect(unlinkedIds).not.toContain(ATTACHED);
    expect(result).toMatchObject({ automationIds: [ATTACHED] });
  });
});
