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

import {
  buildEventPattern,
  flowToSentenceAction,
  flowToSentenceActions,
  toBackendTrigger,
  toFlowDefinition,
  triggerToSentence,
} from "./sentence.js";
import { validateEventPattern } from "../events/unified.js";

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
