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
import type { PlaybookRunNodeDef } from "@synap/database";

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
      // `PlaybookRunNodeDef.data.label` is declared REQUIRED, so the grammar
      // emits it; composed through the vocabulary door, not hand-written here.
      label: "Run playbook",
      playbookId: PB,
      paramsMapping: { topic: "{{trigger.data.title}}" },
    });
  });

  /**
   * `agentType` was BUILT WITH ZERO PRODUCERS: `executePlaybookRun`
   * (`packages/jobs/src/workers/steps/playbook-run.ts`) has read
   * `data.agentType` and forwarded it to the runner since the playbook wave, but
   * `PlaybookRunNodeDef.data` never DECLARED it — so no authoring door could
   * type the field, nothing wrote it, and every playbook run resolved to the
   * default orchestrator ("meta") no matter what the author intended.
   *
   * This test is the producer end of that repair, and it is deliberately typed:
   * the compiled node's data is read THROUGH `PlaybookRunNodeDef["data"]`, so
   * removing the declaration again fails tsc here rather than silently
   * degrading to an untyped passthrough that happens to work.
   */
  it("carries the agent selector through to the executor's node data", () => {
    const result = compileRuleSentence(
      sentence({
        __nodeType: "playbook_run",
        __playbookId: PB,
        __agentType: "researcher",
      })
    );
    expect(result.ok, result.ok ? "" : result.failure.reason).toBe(true);
    if (!result.ok) return;
    const node = result.flow.nodes.find((n) => n.type === "playbook_run");
    expect(node).toBeDefined();
    // The DECLARED node contract, not `Record<string, unknown>`.
    const data = node!.data as PlaybookRunNodeDef["data"];
    expect(data.agentType).toBe("researcher");
    expect(data.playbookId).toBe(PB);
  });

  it("omits agentType entirely when the author chose no agent", () => {
    // Absent, never `undefined`: the executor rebuilds its call field-by-field,
    // and a written-but-undefined key would round-trip as a different node.
    const result = compileRuleSentence(
      sentence({ __nodeType: "playbook_run", __playbookId: PB })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.flow.nodes.find((n) => n.type === "playbook_run")!.data;
    expect("agentType" in data).toBe(false);
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
