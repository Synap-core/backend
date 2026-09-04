/**
 * The rule compiler accepts a playbook_run THEN.
 *
 * `compileRuleSentence` is the compile-or-refuse door every rule create goes
 * through (`createRuleGoverned`). It calls the shared grammar's
 * `toFlowDefinition` and then runs the executor's OWN node contract
 * (`flowValidationErrorMessage`). Both halves had to learn the playbook lane for
 * a playbook THEN to reach a stored automation — a grammar that emits a node the
 * validator rejects refuses at the door, and a validator that accepts a node the
 * grammar never emits is a lane with no producer, which is what `playbook_run`
 * was until this wave.
 */
import { describe, expect, it } from "vitest";
import { compileRuleSentence } from "./compile.js";
import type { RuleSentenceValue } from "@synap-core/types/automations";

const PB = "33333333-3333-4333-8333-333333333333";

const sentence = (config: Record<string, unknown>): RuleSentenceValue => ({
  trigger: {
    triggerType: "event",
    subjectCategory: "entity",
    actionVerb: "created",
  },
  conditions: [],
  actions: [{ type: null, config }],
});

describe("compileRuleSentence — playbook_run THEN", () => {
  it("compiles a playbook THEN to a node the executor dispatches", () => {
    const result = compileRuleSentence(
      sentence({
        __nodeType: "playbook_run",
        __playbookId: PB,
        __actionKey: `playbook:${PB}`,
        topic: "{{trigger.data.title}}",
      })
    );
    expect(result.ok, result.ok ? "" : result.failure.reason).toBe(true);
    if (!result.ok) return;
    const node = result.flow.nodes.find((n) => n.type === "playbook_run");
    expect(node).toBeDefined();
    expect(node!.data).toEqual({
      playbookId: PB,
      paramsMapping: { topic: "{{trigger.data.title}}" },
    });
  });

  it("carries the agent selector through to the node", () => {
    const result = compileRuleSentence(
      sentence({
        __nodeType: "playbook_run",
        __playbookId: PB,
        __agentType: "researcher",
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.flow.nodes.find((n) => n.type === "playbook_run")!.data.agentType
    ).toBe("researcher");
  });

  it("REFUSES a playbook THEN that names no playbook, naming the clause", () => {
    // Neither id nor name ⇒ `isActionConfigured` is false ⇒ no node is emitted
    // ⇒ the compiler must refuse as "no THEN" rather than persist an empty flow
    // that reports active and never fires.
    const result = compileRuleSentence(
      sentence({ __nodeType: "playbook_run" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.clause).toBe("THEN");
  });
});
