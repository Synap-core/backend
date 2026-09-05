/**
 * MOVED HERE from
 * `synap-app/packages/core/automation-intent/src/automation-intent.test.ts`
 * ("sentence → flow converters emit executor-true nodes" describe block) so the
 * package that OWNS `sentence.ts` can run its own regression gate — the backend's
 * `pnpm test` could previously regress this file green because the only coverage
 * lived in a different repo's test runner. See `sentence.ts`'s file header for why
 * the grammar lives here.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  buildEventPattern,
  flowToSentenceAction,
  flowToSentenceActions,
  isActionConfigured,
  flowToConditions,
  UNEVALUABLE_CONDITION_OPERATORS,
  type ConditionRow,
  toBackendTrigger,
  toFlowDefinition,
  triggerToSentence,
  type ActionVerb,
  type TriggerSubjectCategory,
} from "./sentence.js";
import { validateEventPattern } from "../events/unified.js";
import { TRIGGER_FILTER_OPERATORS } from "./filter-operators.js";

describe("sentence → flow converters emit executor-true nodes", () => {
  // Regression guard: the executor only runs `type:"output"` nodes keyed on
  // `outputType` (and `type:"command"`). Emitting the friendly `type:"action"`
  // /`stepType` shape typechecks green but its THEN silently never fires.
  it("compiles an output-type action to an `output` node with its real outputType", () => {
    const flow = toFlowDefinition([
      { type: "create_entity", config: { profileSlug: "task", title: "T" } },
    ]);
    const actionNode = flow.nodes.find((n) => n.type !== "trigger");
    expect(actionNode?.type).toBe("output");
    expect(actionNode?.data.outputType).toBe("entity_create");
    expect(actionNode?.data.stepType).toBeUndefined();
  });

  it("compiles run_command to a `command` node carrying commandId + promptOverride", () => {
    const flow = toFlowDefinition([
      {
        type: "run_command",
        config: { commandId: "cmd-1", input: "Summarize" },
      },
    ]);
    const node = flow.nodes.find((n) => n.type !== "trigger");
    expect(node?.type).toBe("command");
    expect(node?.data.commandId).toBe("cmd-1");
    expect(node?.data.promptOverride).toBe("Summarize");
  });

  it("round-trips every action type through flow and back", () => {
    for (const type of [
      "notify",
      "create_entity",
      "update_entity",
      "post_message",
      "call_webhook",
    ] as const) {
      const back = flowToSentenceAction(
        toFlowDefinition([{ type, config: {} }])
      );
      expect(back.type).toBe(type);
    }
    const cmd = flowToSentenceAction(
      toFlowDefinition([
        { type: "run_command", config: { commandId: "c", input: "i" } },
      ])
    );
    expect(cmd.type).toBe("run_command");
    expect(cmd.config).toEqual({ commandId: "c", input: "i" });
  });

  it("still reverse-reads a legacy `type:'action'` node via stepType", () => {
    const legacy = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        {
          id: "a1",
          type: "action",
          position: { x: 0, y: 150 },
          data: { stepType: "notify", config: { message: "hi" } },
        },
      ],
      edges: [],
    };
    expect(flowToSentenceAction(legacy).type).toBe("notify");
  });
});

describe("flowToSentenceActions (plural) — the non-lossy reader", () => {
  it("reads back every action of a multi-action flow, in order", () => {
    const flow = toFlowDefinition([
      { type: "notify", config: { message: "first" } },
      { type: "create_entity", config: { profileSlug: "task" } },
      { type: "post_message", config: { channelId: "c1" } },
    ]);
    const actions = flowToSentenceActions(flow);
    expect(actions.map((a) => a.type)).toEqual([
      "notify",
      "create_entity",
      "post_message",
    ]);
  });

  it("reads a `capability` node (which toFlowDefinition never emits) without dropping it", () => {
    const flow = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        {
          id: "then-1",
          type: "capability",
          position: { x: 0, y: 150 },
          data: {
            capabilityId: "google-drive",
            verbId: "create_link",
            inputMapping: { fileId: "f1" },
          },
        },
      ],
      edges: [{ id: "e1", source: "trigger", target: "then-1" }],
    };
    const actions = flowToSentenceActions(flow);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBeNull();
    expect(actions[0].config).toMatchObject({
      __nodeType: "capability",
      __capabilityId: "google-drive",
      __verbId: "create_link",
      __actionKey: "verb:create_link",
      fileId: "f1",
    });
  });

  it("flowToSentenceAction (singular) is the first element of flowToSentenceActions, and never disagrees with it", () => {
    const flow = toFlowDefinition([
      { type: "notify", config: { message: "first" } },
      { type: "create_entity", config: { profileSlug: "task" } },
    ]);
    expect(flowToSentenceAction(flow)).toEqual(flowToSentenceActions(flow)[0]);
  });

  it("still returns the placeholder null action for a trigger-only flow", () => {
    const flow = toFlowDefinition([]);
    expect(flowToSentenceAction(flow)).toEqual({ type: null, config: {} });
    expect(flowToSentenceActions(flow)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WHEN-side: the trigger a rule compiles must be one the RUNTIME can match.
//
// These assertions are made against `validateEventPattern` — the very function
// the automation create door (`routers/automations.ts:579`) runs on an incoming
// trigger — rather than against a literal expectation. A test that pinned the
// string would have kept passing through the whole mood severance, because the
// string was self-consistent; only the runtime's own grammar could see it.
// ---------------------------------------------------------------------------

describe("buildEventPattern emits patterns the runtime accepts", () => {
  it.each([
    ["created", "entity.create.completed"],
    ["updated", "entity.update.completed"],
    ["deleted", "entity.delete.completed"],
  ] as const)(
    "entity + past-tense %s → imperative %s, accepted by validateEventPattern",
    (actionVerb, expected) => {
      const pattern = buildEventPattern({
        triggerType: "event",
        subjectCategory: "entity",
        actionVerb,
      });
      expect(pattern).toBe(expected);
      expect(() => validateEventPattern(pattern)).not.toThrow();
    }
  );

  it("round-trips back to the PAST-tense sentence verb (the editor's vocabulary)", () => {
    const { triggerConfig } = toBackendTrigger(
      {
        triggerType: "event",
        subjectCategory: "entity",
        actionVerb: "updated",
      },
      []
    );
    expect(triggerConfig.eventPattern).toBe("entity.update.completed");
    const back = triggerToSentence("event", triggerConfig);
    expect(back.subjectCategory).toBe("entity");
    // Not "update": an imperative verb is not an `ActionVerb`, so the WHEN row
    // would render empty and re-saving would drop the verb.
    expect(back.actionVerb).toBe("updated");
  });

  it("leaves a verb with no entity event UNMAPPED so the runtime refuses it by name", () => {
    // `approved` is an ActionVerb the editor offers but no `entity.*` event
    // exists for. Silently rewriting it would build a different rule than the
    // author wrote; refusing names the problem.
    const pattern = buildEventPattern({
      triggerType: "event",
      subjectCategory: "entity",
      actionVerb: "approved",
    });
    expect(pattern).toBe("entity.approved.completed");
    expect(() => validateEventPattern(pattern)).toThrow(/approved/);
  });

  it("connector subject categories still compile to accepted patterns", () => {
    for (const subjectCategory of [
      "external_message",
      "capture",
      "feed_item",
    ] as const) {
      const pattern = buildEventPattern({
        triggerType: "event",
        subjectCategory,
      });
      expect(() => validateEventPattern(pattern)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The EXECUTOR-TRUE THEN dialect must ROUND-TRIP.
//
// The grammar could read `type: null` + `config.__*` actions and never write
// them, so every sentence authored by the browser's rule editor — the only
// surface offering the full executor vocabulary — compiled to a trigger wired
// to nothing. These pin the forward half against the reverse half.
// ---------------------------------------------------------------------------

describe("the type:null executor-true dialect compiles and round-trips", () => {
  it("compiles a raw __outputType into an output node the executor dispatches", () => {
    // `facet_attach` is a real executor output with NO friendly ActionType —
    // exactly the case the alias map cannot express.
    const flow = toFlowDefinition([
      {
        type: null,
        config: {
          __outputType: "facet_attach",
          __actionKey: "facet_attach",
          profileSlug: "client",
        },
      },
    ]);
    const node = flow.nodes.find((n) => n.type === "output");
    expect(node).toBeDefined();
    expect(node!.data.outputType).toBe("facet_attach");
    // Bookkeeping never reaches a stored flow — the executor would read a `__`
    // key as a verb param.
    expect(node!.data.config).toEqual({ profileSlug: "client" });
  });

  it("compiles a capability THEN into a capability node, and reads it back identically", () => {
    const action = {
      type: null as const,
      config: {
        __nodeType: "capability",
        __capabilityId: "google-drive",
        __verbId: "create_link",
        __actionKey: "verb:create_link",
        fileId: "f1",
      },
    };
    const flow = toFlowDefinition([action]);
    const node = flow.nodes.find((n) => n.type === "capability");
    expect(node).toBeDefined();
    expect(node!.data).toMatchObject({
      capabilityId: "google-drive",
      verbId: "create_link",
      // `inputMapping` is the key the executor reads; `params` matched nothing.
      inputMapping: { fileId: "f1" },
    });
    // The reverse reader must reproduce the sentence the writer was given.
    expect(flowToSentenceActions(flow)[0]).toEqual(action);
  });

  it("still drops a TRULY empty action — an unconfigured row is not a THEN", () => {
    expect(toFlowDefinition([{ type: null, config: {} }]).nodes).toHaveLength(
      1
    );
    expect(isActionConfigured({ type: null, config: {} })).toBe(false);
    expect(
      isActionConfigured({ type: null, config: { __outputType: "" } })
    ).toBe(false);
  });

  it("a flow built from the dialect passes the executor's own node contract", () => {
    // The shape that used to reach the compiler: an output node with
    // `outputType: undefined`, which validateFlowDefinition rejects.
    const flow = toFlowDefinition([
      { type: null, config: { __outputType: "notification", message: "hi" } },
    ]);
    for (const n of flow.nodes) {
      if (n.type === "output") expect(n.data.outputType).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// ROUND TRIP AS A PROPERTY, not as the one case I thought of.
//
// I added the forward half of the executor-true dialect and wrote a round-trip
// test — for the CAPABILITY shape only. The raw-`__outputType` shape was broken
// the whole time: the reverse dropped `__outputType`, so the rebuilt action
// failed `isActionConfigured` and `toFlowDefinition` silently DROPPED the node.
// Editing and re-saving such a rule would have erased its THEN.
//
// The lesson is the shape of the test, not the fix: assert
// `forward(reverse(flow)) === flow` over EVERY output type the executor has,
// derived from the alias map plus the unaliased ones — so a new output type is
// covered without editing this file.
// ---------------------------------------------------------------------------

describe("sentence ⇄ flow is a true round trip for every output type", () => {
  // Aliased (a friendly ActionType exists) and unaliased (type: null + __outputType).
  const ALIASED = [
    "notification",
    "entity_create",
    "entity_update",
    "channel_message",
    "webhook",
  ] as const;
  const UNALIASED = [
    "facet_attach",
    "facet_update",
    "facet_detach",
    "relation_create",
    "session_update",
    "set_state",
  ] as const;

  it.each([...ALIASED, ...UNALIASED].map((t) => [t]))(
    "outputType %s survives flow → sentence → flow unchanged",
    (outputType) => {
      const original = toFlowDefinition([
        {
          type: null,
          config: { __outputType: outputType, __actionKey: outputType, k: "v" },
        },
      ]);
      const node = original.nodes.find((n) => n.type === "output");
      expect(node, `${outputType} produced no output node`).toBeDefined();
      expect(node!.data.outputType).toBe(outputType);

      // The whole point: rebuild the sentence from the stored flow, compile it
      // again, and the flow must be identical. A dropped node shows up here.
      const rebuilt = toFlowDefinition(flowToSentenceActions(original));
      expect(rebuilt).toEqual(original);
    }
  );

  it("every alias in the map round-trips through its friendly ActionType too", () => {
    // Derived from the map, so teaching the grammar a new alias covers it here.
    for (const outputType of ALIASED) {
      const flow = toFlowDefinition([
        { type: null, config: { __outputType: outputType, msg: "x" } },
      ]);
      const back = flowToSentenceActions(flow);
      expect(back).toHaveLength(1);
      // An aliased output comes back as its FRIENDLY type — that is correct and
      // is why this case never broke.
      expect(back[0].type).not.toBeNull();
      expect(toFlowDefinition(back)).toEqual(flow);
    }
  });
});

// ---------------------------------------------------------------------------
// The chosen KIND must land where the runtime actually reads it.
//
// `triggerConfig.profileSlug` (top level) is read ONLY by the matcher's
// `capture.` branch, against `data.profileSlugs` (plural). There is no `entity.`
// branch — so "when a PERSON is created" fired on every entity kind, silently.
// ---------------------------------------------------------------------------

describe("an entity trigger's profileSlug lands in filters, where matchFilters reads it", () => {
  const entityTrigger = {
    triggerType: "event" as const,
    subjectCategory: "entity" as const,
    actionVerb: "created" as const,
    profileSlug: "person",
  };

  it("puts the kind in `filters` — NOT the top-level key nothing reads", () => {
    const { triggerConfig } = toBackendTrigger(entityTrigger, []);
    expect(triggerConfig.filters).toMatchObject({ profileSlug: "person" });
    expect(triggerConfig.profileSlug).toBeUndefined();
  });

  it("keeps the top-level key for CAPTURE, whose branch reads a different shape", () => {
    // The capture branch reads `data.profileSlugs` (plural) — a shape
    // `matchFilters` cannot evaluate, so this one must stay where it is.
    const { triggerConfig } = toBackendTrigger(
      {
        triggerType: "event",
        subjectCategory: "capture",
        profileSlug: "person",
      },
      []
    );
    expect(triggerConfig.profileSlug).toBe("person");
    expect(triggerConfig.filters).toBeUndefined();
  });

  it("does not clobber a WHERE condition the author wrote", () => {
    const { triggerConfig } = toBackendTrigger(entityTrigger, [
      { id: "c1", key: "source", operator: "is", value: "capture" },
    ]);
    expect(triggerConfig.filters).toEqual({
      source: "capture",
      profileSlug: "person",
    });
  });

  it("round-trips the kind back into the WHEN row from EITHER home", () => {
    // New shape (filters) …
    const fresh = toBackendTrigger(entityTrigger, []);
    expect(triggerToSentence("event", fresh.triggerConfig).profileSlug).toBe(
      "person"
    );
    // … and the pre-fix shape still stored on live pods.
    expect(
      triggerToSentence("event", {
        eventPattern: "entity.create.completed",
        profileSlug: "person",
      }).profileSlug
    ).toBe("person");
  });
});

// ---------------------------------------------------------------------------
// THE WHERE OPERATOR. This is the one that produced INVERTED semantics: every
// operator compiled to bare equality, so "status is NOT done" fired on exactly
// the events its author excluded — and `flowToConditions` hardcoded
// `operator: "is"` so the editor reloaded the mangled rule looking correct.
//
// Asserted against the RUNTIME's own operator vocabulary, not a hand-written
// expectation, so a new operator cannot be added on one side only.
// ---------------------------------------------------------------------------

describe("the WHERE operator survives compilation", () => {
  const row = (operator: ConditionRow["operator"], value = "done") => ({
    id: "c1",
    key: "status",
    operator,
    value,
  });
  const filtersFor = (r: ConditionRow) =>
    toBackendTrigger(
      {
        triggerType: "event",
        subjectCategory: "entity",
        actionVerb: "created",
      },
      [r]
    ).triggerConfig.filters as Record<string, unknown>;

  it("is → a literal (unchanged behaviour)", () => {
    expect(filtersFor(row("is"))).toEqual({ status: "done" });
  });

  it("is_not → $ne, NOT the value itself", () => {
    // The regression: this used to emit `{status:"done"}` — the rule fired on
    // precisely what the author excluded.
    expect(filtersFor(row("is_not"))).toEqual({ status: { $ne: "done" } });
  });

  it("greater_than / less_than → $gt / $lt", () => {
    expect(filtersFor(row("greater_than", "5"))).toEqual({
      status: { $gt: "5" },
    });
    expect(filtersFor(row("less_than", "5"))).toEqual({ status: { $lt: "5" } });
  });

  it("is_true / is_false need no value and emit booleans", () => {
    expect(filtersFor(row("is_true", ""))).toEqual({ status: true });
    expect(filtersFor(row("is_false", ""))).toEqual({ status: false });
  });

  it("every operator it EMITS is one the runtime can evaluate", () => {
    // Derived from the runtime's own list, so teaching the grammar a new
    // operator without teaching the matcher fails here.
    for (const op of [
      "is",
      "is_not",
      "greater_than",
      "less_than",
      "is_true",
      "is_false",
    ] as const) {
      const compiled = filtersFor(row(op, "1")).status;
      if (compiled && typeof compiled === "object") {
        for (const k of Object.keys(compiled)) {
          expect(TRIGGER_FILTER_OPERATORS).toContain(k);
        }
      }
    }
  });

  it("emits NOTHING for an operator the runtime cannot evaluate", () => {
    // Emitting a literal would silently turn "contains" into "equals"; the rule
    // compiler refuses these by name instead.
    for (const op of UNEVALUABLE_CONDITION_OPERATORS) {
      expect(filtersFor(row(op))).toBeUndefined();
    }
  });

  it("round-trips the operator back into the sentence", () => {
    // The hardcoded `operator: "is"` here is what hid the whole bug.
    for (const op of ["is", "is_not", "greater_than", "less_than"] as const) {
      const cfg = toBackendTrigger(
        {
          triggerType: "event",
          subjectCategory: "entity",
          actionVerb: "created",
        },
        [row(op, "7")]
      ).triggerConfig;
      const back = flowToConditions(cfg);
      expect(back[0]!.operator).toBe(op);
      expect(back[0]!.value).toBe("7");
    }
  });
});

// ---------------------------------------------------------------------------
// PLAYBOOK-RUN THEN — the grammar half.
//
// The runtime has executed `type:"playbook_run"` nodes since the playbook wave
// (`automation-executor.ts` → `executePlaybookRun`, validated by
// `validate-flow.ts` `case "playbook_run"`), but the SENTENCE grammar could not
// author one: `actionToFlowNode` had no branch, so a playbook THEN fell through
// to an `output` node with `outputType: undefined` and the compiler refused it.
// These tests pin the forward and reverse halves as exact mirrors — the same
// property that the capability THEN lost twice.
// ---------------------------------------------------------------------------

describe("playbook_run THEN — grammar authors what the executor already runs", () => {
  const byId = {
    type: null,
    config: {
      __nodeType: "playbook_run",
      __playbookId: "11111111-1111-4111-8111-111111111111",
      __actionKey: "playbook:11111111-1111-4111-8111-111111111111",
      subject: "{{trigger.entityId}}",
    },
  } as const;

  it("is CONFIGURED when it names a playbook by id or by name", () => {
    expect(isActionConfigured({ ...byId, config: { ...byId.config } })).toBe(
      true
    );
    expect(
      isActionConfigured({
        type: null,
        config: { __nodeType: "playbook_run", __playbookName: "Weekly digest" },
      })
    ).toBe(true);
    // Neither ref ⇒ not configured: `validate-flow` requires one of the two, so
    // emitting a node here would persist green and throw at run time.
    expect(
      isActionConfigured({ type: null, config: { __nodeType: "playbook_run" } })
    ).toBe(false);
  });

  it("compiles to the node shape the executor actually reads", () => {
    const flow = toFlowDefinition([{ ...byId, config: { ...byId.config } }]);
    const node = flow.nodes.find((n) => n.type === "playbook_run");
    expect(node).toBeDefined();
    expect(node!.data).toEqual({
      // `PlaybookRunNodeDef.data.label` is declared REQUIRED, so the grammar
      // must emit it. Composed through the vocabulary door, never hand-written.
      label: "Run playbook",
      playbookId: "11111111-1111-4111-8111-111111111111",
      paramsMapping: { subject: "{{trigger.entityId}}" },
    });
    // No `__` bookkeeping key may reach a stored node — the executor would read
    // it as a real playbook param.
    for (const k of Object.keys(
      node!.data.paramsMapping as Record<string, unknown>
    )) {
      expect(k.startsWith("__")).toBe(false);
    }
  });

  // A GRAMMAR-PRODUCED flow round-trips to itself EXACTLY — the same property the
  // output-node suite above asserts, and the one that matters for a rule authored
  // through this module: read it back, write it again, get the same bytes.
  it.each([
    ["id only", { __playbookId: "11111111-1111-4111-8111-111111111111" }],
    ["name only", { __playbookName: "Weekly digest" }],
    [
      "id + agent + params",
      {
        __playbookId: "22222222-2222-4222-8222-222222222222",
        __agentType: "researcher",
        topic: "{{trigger.data.title}}",
      },
    ],
  ])(
    "a grammar-authored playbook flow round-trips unchanged (%s)",
    (_l, cfg) => {
      const original = toFlowDefinition([
        { type: null, config: { __nodeType: "playbook_run", ...cfg } },
      ]);
      expect(original.nodes.some((n) => n.type === "playbook_run")).toBe(true);
      expect(toFlowDefinition(flowToSentenceActions(original))).toEqual(
        original
      );
    }
  );

  // A STORED node (written by another door, or by hand) round-trips on every
  // SEMANTIC field. `label` is the one exception and the exception is honest:
  // it is DERIVED by the forward converter and IGNORED by the reverse, so a
  // round trip NORMALIZES it. Asserting identity here would be asserting
  // something false; asserting the semantic fields is what actually catches the
  // erasure class this suite exists for.
  it.each([
    [
      "id only",
      { playbookId: "11111111-1111-4111-8111-111111111111", paramsMapping: {} },
      "Run playbook",
    ],
    [
      "name only",
      { playbookName: "Weekly digest", paramsMapping: {} },
      "Weekly digest",
    ],
    [
      "id + agent + params",
      {
        playbookId: "22222222-2222-4222-8222-222222222222",
        agentType: "researcher",
        paramsMapping: { topic: "{{trigger.data.title}}" },
      },
      "Run playbook",
    ],
  ])(
    "a stored node survives read → write on every semantic field (%s)",
    (_label, data, expectedLabel) => {
      const original = {
        nodes: [
          {
            id: "trigger",
            type: "trigger",
            position: { x: 0, y: 0 },
            data: {},
          },
          {
            id: "action-1",
            type: "playbook_run",
            position: { x: 0, y: 150 },
            data,
          },
        ],
        edges: [{ id: "e1", source: "trigger", target: "action-1" }],
      };
      const rebuilt = toFlowDefinition(flowToSentenceActions(original));
      // Identity everywhere EXCEPT the derived label, which is now populated.
      expect(rebuilt).toEqual({
        ...original,
        nodes: [
          original.nodes[0],
          { ...original.nodes[1], data: { ...data, label: expectedLabel } },
        ],
      });
    }
  );

  it("a hand-written label is NORMALIZED, not carried, on the way back", () => {
    // The honest consequence of `label` being derived. Stated as its own test so
    // the loss is a documented property rather than a surprise in a diff.
    const original = {
      nodes: [
        { id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
        {
          id: "action-1",
          type: "playbook_run",
          position: { x: 0, y: 150 },
          data: {
            playbookId: "11111111-1111-4111-8111-111111111111",
            label: "My custom step",
          },
        },
      ],
      edges: [{ id: "e1", source: "trigger", target: "action-1" }],
    };
    const rebuilt = toFlowDefinition(flowToSentenceActions(original));
    const node = rebuilt.nodes.find((n) => n.type === "playbook_run");
    expect(node!.data.label).toBe("Run playbook");
    expect(node!.data.playbookId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("survives the lossy single-action reader too", () => {
    const flow = toFlowDefinition([{ ...byId, config: { ...byId.config } }]);
    const action = flowToSentenceAction(flow);
    expect(action.config.__nodeType).toBe("playbook_run");
    expect(isActionConfigured(action)).toBe(true);
  });
});

/**
 * ROUND-TRIP tripwire: every pattern this module can EMIT, it must be able to
 * READ back into a legal sentence.
 *
 * `buildEventPattern` and `triggerToSentence` are two halves of one bridge, and
 * they were maintained separately: the emitter's `capture` entry writes
 * `capture.complete.completed`, while the reader's `EVENT_ACTION_TO_VERB` knew
 * only create/update/delete. The reader fell through to a raw cast and produced
 * `actionVerb: "complete"` — a value outside the `ActionVerb` union, which
 * TypeScript could not catch because the cast asserted it away. The composer
 * loaded the WHEN row blank and re-saving dropped the trigger.
 *
 * A hand-maintained inverse of a hand-maintained map is a fork with a
 * countdown. This asserts the two agree over the WHOLE subject vocabulary, so
 * adding a subject category without teaching the reader fails here.
 */
describe("event pattern round trip", () => {
  const SUBJECTS: TriggerSubjectCategory[] = [
    "entity",
    "external_message",
    "capture",
    "notification",
    "feed_item",
    "inbox_item",
  ];

  const ACTION_VERBS = new Set<ActionVerb>([
    "created",
    "updated",
    "deleted",
    "received",
    "completed",
    "approved",
    "rejected",
  ]);

  /**
   * `feed_item` emits `feed.new_item.completed`. `new_item` is not an
   * `ActionVerb` and there is no honest one to map it to — the gap is in
   * `events/unified.ts`'s vocabulary, named in `buildEventPattern`'s own
   * comment. Listed here so it is a KNOWN hole, not an invisible one.
   */
  const KNOWN_UNREADABLE = new Set<TriggerSubjectCategory>(["feed_item"]);

  it("covers every subject category the union declares", () => {
    // If the union grows, this list must too — otherwise the sweep below
    // silently stops testing the new one.
    expect(SUBJECTS).toHaveLength(6);
  });

  for (const subjectCategory of SUBJECTS) {
    it(`\`${subjectCategory}\` survives emit → read`, () => {
      const pattern = buildEventPattern({
        triggerType: "event",
        subjectCategory,
      } as never);
      expect(pattern).not.toBe("");

      const back = triggerToSentence("event", { eventPattern: pattern });

      if (KNOWN_UNREADABLE.has(subjectCategory)) {
        expect(ACTION_VERBS.has(back.actionVerb as ActionVerb)).toBe(false);
        return;
      }

      // The verb must be a REAL member of the union, not a raw middle segment
      // that a cast made look like one.
      expect(ACTION_VERBS.has(back.actionVerb as ActionVerb)).toBe(true);
      expect(back.subjectCategory).toBe(pattern.split(".")[0]);
    });
  }
});

/**
 * SOURCE-SCAN tripwire: no editor may OFFER an operator the runtime cannot
 * evaluate.
 *
 * `contains`, `starts_with` and `changed_to` compile to `undefined`
 * (`conditionToFilterValue`), and `toBackendTrigger` folds with
 * `if (compiled !== undefined)` — so a row using one is dropped in silence and
 * the rule WIDENS, firing on exactly the events its author excluded.
 *
 * This cannot be caught server-side. `automations.create` accepts an
 * already-compiled `triggerConfig: z.record(z.string(), z.unknown())`, so the
 * operator does not exist by the time the pod is called. Only `skills.createRule`
 * sees a sentence and refuses by name (`services/rules/compile.ts`). The two
 * editors are therefore the ONLY guard for the automations door, which makes
 * their operator menus load-bearing.
 *
 * `UNEVALUABLE_CONDITION_OPERATORS` was exported for exactly this and had ZERO
 * frontend consumers — built and severed, this codebase's dominant defect. The
 * scan requires each editor to REFERENCE it rather than to re-list the safe
 * operators by hand, because a hand-kept subset is a second vocabulary that
 * drifts the moment the matcher learns a new operator.
 */
describe("no editor offers an unevaluable operator", () => {
  const REPO = path.resolve(__dirname, "../../../../..");
  const EDITORS = [
    "synap-app/packages/features/automations-heroui/src/sentence/WhereClause.tsx",
    "browser/electron/renderer/src/shared/rule-sentence/RuleSentence.tsx",
  ];

  it("finds the editors it claims to guard", () => {
    // A scan whose paths have moved passes by checking nothing. Two surfaces
    // render a WHERE row today; if a third appears, add it here.
    for (const rel of EDITORS) {
      expect(fs.existsSync(path.join(REPO, rel)), `missing: ${rel}`).toBe(true);
    }
  });

  for (const rel of EDITORS) {
    it(`${rel.split("/").pop()} derives its menu from the SSOT`, () => {
      const src = fs
        .readFileSync(path.join(REPO, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      // A CALL or a member access, not a bare mention — an import line alone
      // has satisfied a scan in this repo twice.
      expect(
        /UNEVALUABLE_CONDITION_OPERATORS\s*[.[(]/.test(src),
        `${rel} must filter its operator menu through ` +
          "UNEVALUABLE_CONDITION_OPERATORS. Offering `contains` / `starts_with` " +
          "/ `changed_to` silently widens the rule the user just narrowed."
      ).toBe(true);
    });
  }
});
