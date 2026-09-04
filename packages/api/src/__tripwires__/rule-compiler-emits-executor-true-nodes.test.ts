/**
 * TRIPWIRE — everything the rule compiler can EMIT is something the runtime
 * actually DISPATCHES.
 *
 * `compileRuleSentence` turns a rule sentence into an `automations` row through
 * the shared grammar in `@synap-core/types/automations` (`sentence.ts`). If the
 * grammar emits a node `type` or an output `outputType` that the executor has no
 * branch for, the automation PERSISTS, reports `active`, typechecks green — and
 * its THEN never fires. That is not hypothetical: `toFlowDefinition` emitted
 * `type:"action"` + `data.stepType` for months against an executor with no
 * `case "action"`, and the WHEN half is severed the same way TODAY (see the
 * cron-key assertion at the bottom).
 *
 * ── Why this is SOURCE-DERIVED, not a list ─────────────────────────────────
 * Both sides are parsed out of the files that own the truth:
 *   • EMITTABLE: the `ACTION_TO_OUTPUT_TYPE` map and the `type:"…"` literals in
 *     `actionToFlowNode` / `toFlowDefinition`, read from `sentence.ts`.
 *   • DISPATCHED: the `case "…"` labels of the executor's own
 *     `switch (node.type)` and of `steps/output.ts`'s `switch (data.outputType)`.
 * Neither set is written down here, so this test cannot be satisfied by an
 * import line (the vacuous-tripwire shape this repo has shipped) and cannot rot
 * into a hand-maintained mirror — the exact `PROJECTED_SKILL_FIELDS` /
 * projection-parity discipline `capability-drift` uses. Teaching the grammar a
 * new action, or the executor a new node, is picked up with no edit here.
 *
 * `@synap/api` does not depend on `@synap/jobs`, so a compile-time guard is
 * impossible; reading the source is the only mechanism available. Guarded like
 * `cp-pod-package-schema-parity`: if a file is missing the test FAILS rather
 * than reporting green over an empty string.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `src/__tripwires__` → src → api → packages → synap-backend. */
const BACKEND_ROOT = join(import.meta.dirname, "../../../..");

const SENTENCE = join(
  BACKEND_ROOT,
  "packages/types/src/automations/sentence.ts"
);
const EXECUTOR = join(
  BACKEND_ROOT,
  "packages/jobs/src/workers/automation-executor.ts"
);
const OUTPUT_STEP = join(
  BACKEND_ROOT,
  "packages/jobs/src/workers/steps/output.ts"
);
const CRON_SCHEDULER = join(
  BACKEND_ROOT,
  "packages/jobs/src/workers/automation-cron-scheduler.ts"
);
const COMPILER = join(
  BACKEND_ROOT,
  "packages/api/src/services/rules/compile.ts"
);

function read(file: string): string {
  if (!existsSync(file)) {
    throw new Error(
      `Tripwire cannot read its subject: ${file}. A moved file must move this test, not silence it.`
    );
  }
  return readFileSync(file, "utf8");
}

/** Strip comments so prose examples can never be read as code. */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * The `case "x":` labels of the FIRST `switch (<subject>)` in `src`. Scoped to
 * one switch by brace-balancing from the switch's own `{`, so unrelated switches
 * in the same file (the executor's nested loop-body dispatch, its duration-unit
 * switch) cannot inflate the set and make the assertion vacuously true.
 */
function caseLabelsOfSwitch(src: string, subject: string): string[] {
  const at = src.indexOf(`switch (${subject})`);
  expect(
    at,
    `no \`switch (${subject})\` found — the dispatch this tripwire reads has moved`
  ).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(open, end);
  return [...body.matchAll(/case\s+"([a-z_]+)"\s*:/g)].map((m) => m[1]!);
}

/**
 * The brace-balanced body of a named function in `src`. Used instead of
 * "slice to end of file" so a scan of the forward converters cannot pick up
 * literals from the reverse ones further down the module.
 */
function functionBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}`);
  expect(
    at,
    `\`function ${name}\` not found — the builder this tripwire reads has moved`
  ).toBeGreaterThan(-1);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

describe("rule compiler emits only executor-true output types", () => {
  const sentence = strip(read(SENTENCE));

  /** Every value of `ACTION_TO_OUTPUT_TYPE` — what an `output` node can carry. */
  const emittableOutputTypes = (() => {
    const at = sentence.indexOf("ACTION_TO_OUTPUT_TYPE");
    expect(
      at,
      "ACTION_TO_OUTPUT_TYPE not found in sentence.ts — the compiler's output-type source has moved"
    ).toBeGreaterThan(-1);
    const open = sentence.indexOf("{", at);
    const close = sentence.indexOf("}", open);
    const body = sentence.slice(open, close);
    const values = [...body.matchAll(/:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    // A parse that finds nothing must fail, not pass an empty ⊆ assertion.
    expect(values.length).toBeGreaterThan(0);
    return values;
  })();

  const dispatchedOutputTypes = caseLabelsOfSwitch(
    strip(read(OUTPUT_STEP)),
    "data.outputType"
  );

  it("parsed both sides (the sets are non-empty)", () => {
    expect(emittableOutputTypes.length).toBeGreaterThan(0);
    expect(dispatchedOutputTypes.length).toBeGreaterThan(0);
  });

  it.each(emittableOutputTypes.map((t) => [t]))(
    'outputType "%s" has a branch in steps/output.ts',
    (outputType) => {
      expect(dispatchedOutputTypes).toContain(outputType);
    }
  );
});

describe("rule compiler emits only executor-true node types", () => {
  const sentence = strip(read(SENTENCE));
  const executor = strip(read(EXECUTOR));

  /**
   * Every `type: "…"` literal the flow builders write. Scoped to the BODIES of
   * the two functions that build nodes — brace-balanced, not "from here to end
   * of file". The looser slice swept in the REVERSE converters
   * (`flowNodeToSentenceAction` builds a `SentenceAction` with
   * `type: "run_command"`, which is an ActionType, not a node type) and asserted
   * the executor must dispatch a node type the grammar never emits.
   */
  const emittableNodeTypes = (() => {
    const types = new Set<string>();
    for (const fn of ["actionToFlowNode", "toFlowDefinition"]) {
      const body = functionBody(sentence, fn);
      for (const m of body.matchAll(/\btype:\s*"([a-z_]+)"/g)) types.add(m[1]!);
    }
    expect(types.size).toBeGreaterThan(0);
    return [...types];
  })();

  const dispatchedNodeTypes = caseLabelsOfSwitch(executor, "node.type");

  it("parsed both sides (the sets are non-empty)", () => {
    expect(emittableNodeTypes.length).toBeGreaterThan(0);
    expect(dispatchedNodeTypes.length).toBeGreaterThan(0);
  });

  it("the executor explicitly skips the trigger node", () => {
    // `trigger` is the one emitted type with no `case`: the executor `continue`s
    // past it because the trigger already fired. Pinned so "trigger is fine"
    // stays a fact about the executor rather than an assumption in this test.
    expect(executor).toMatch(/node\.type\s*===\s*"trigger"\)\s*continue/);
  });

  it.each(emittableNodeTypes.map((t) => [t]))(
    'node type "%s" is dispatched by automation-executor.ts',
    (nodeType) => {
      if (nodeType === "trigger") return; // covered by the skip assertion above
      expect(dispatchedNodeTypes).toContain(nodeType);
    }
  );
});

describe("the compiler's cron gate names the key the scheduler reads", () => {
  it("RUNTIME_CRON_KEY is the triggerConfig key automation-cron-scheduler.ts reads", () => {
    const scheduler = strip(read(CRON_SCHEDULER));
    const match = scheduler.match(/triggerConfig\??\.([a-zA-Z]+) as string/);
    expect(
      match,
      "could not find the scheduler's triggerConfig read — the cron contract has moved"
    ).not.toBeNull();
    const runtimeKey = match![1];

    const compiler = strip(read(COMPILER));
    const declared = compiler.match(/RUNTIME_CRON_KEY\s*=\s*"([a-zA-Z]+)"/);
    expect(
      declared,
      "RUNTIME_CRON_KEY not declared in compile.ts"
    ).not.toBeNull();
    expect(declared![1]).toBe(runtimeKey);
  });

  it("the grammar WRITES that key (the severance this gate was built for is closed)", () => {
    // This assertion replaces the one that pinned the severance as a fact about
    // TODAY. The grammar now writes `expression` as authoritative, so the
    // compiler's cron refusal no longer fires for a well-formed schedule rule —
    // it remains as the guard that would catch the key being dropped again.
    // `cron` must ALSO still be written: rows stored before the fix carry only
    // that key, and `triggerToSentence` reads `expression ?? cron`.
    const sentence = strip(read(SENTENCE));
    const at = sentence.indexOf("function toBackendTrigger");
    const region = sentence.slice(at, at + 1200);
    expect(region).toMatch(/expression:\s*cron/);
    expect(region).toMatch(/\bcron,/);
  });
});

describe("the WHEN half compiles to patterns the runtime accepts", () => {
  it("the mood bridge maps every past-tense verb the entity pattern can carry", () => {
    // The severance: `ActionVerb` is PAST, `EVENT_ACTIONS` is IMPERATIVE, so
    // `entity.created.completed` reached a door that rejects it and every
    // entity-event rule was unbuildable. Derived from BOTH vocabularies rather
    // than pinning the three pairs, so teaching the grammar a fourth CRUD verb
    // cannot leave it unbridged.
    const sentence = strip(read(SENTENCE));
    const unified = strip(
      read(join(BACKEND_ROOT, "packages/types/src/events/unified.ts"))
    );

    const actionsAt = unified.indexOf("EVENT_ACTIONS = [");
    expect(actionsAt, "EVENT_ACTIONS not found").toBeGreaterThan(-1);
    const eventActions = [
      ...unified
        .slice(actionsAt, unified.indexOf("]", actionsAt))
        .matchAll(/"([a-z_]+)"/g),
    ].map((m) => m[1]!);
    expect(eventActions.length).toBeGreaterThan(0);

    const bridgeAt = sentence.indexOf("VERB_TO_EVENT_ACTION");
    expect(
      bridgeAt,
      "VERB_TO_EVENT_ACTION not found in sentence.ts — the mood bridge has moved or been removed"
    ).toBeGreaterThan(-1);
    const bridge = sentence.slice(
      sentence.indexOf("{", bridgeAt),
      sentence.indexOf("}", bridgeAt)
    );
    const mapped = [...bridge.matchAll(/:\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(mapped.length).toBeGreaterThan(0);

    // Everything the bridge produces must be a real EventAction — otherwise it
    // has merely moved the invalid pattern behind an indirection.
    for (const action of mapped) expect(eventActions).toContain(action);

    // And the entity pattern must be built THROUGH the bridge, not from the raw
    // verb: `entity.${actionVerb}` is the exact shape that was broken.
    // Brace-balanced, via this file's own helper. Slicing to the first `}` after
    // PATTERN_MAP lands inside the template literal `${entityAction}` — it
    // happened to contain the assertion's subject today, and would have stopped
    // doing so the moment the map was reordered.
    const buildRegion = functionBody(sentence, "buildEventPattern");
    expect(buildRegion).not.toMatch(/entity\.\$\{actionVerb/);
  });
});
