/**
 * BRACKET PATH GRAMMAR — `steps["query-1"].output.count`
 *
 * Until 2026-09-03 `lookupContextPath` was a pure `split(".")`, so a bracket
 * reference was one nonsense segment (`steps["query-1"]`) that was never a key
 * on the context. It resolved `miss: "missing"` → rendered `""` → `"" > 0` was
 * FALSE, so `evaluateCondition` pruned the `yes` branch and every descendant was
 * marked `skipped` while the run still finalized `completed`.
 *
 * Two shipped relay flows (`Daily Reconnection Nudges`, `Event Prep Briefing`)
 * are authored with bracket paths BECAUSE the node id `query-1` contains a
 * hyphen — `steps.query-1.output` cannot express it. Live proof both ways:
 * run 4c42a659 (Event Prep Briefing, 5 entities returned) and run 41ac1b09
 * (Daily Reconnection Nudges, 0 entities) recorded the SAME
 * `__unresolvedRefs: [{ path: 'steps["query-1"].output.count', reason: "missing" }]`
 * — one with data, one without, so the defect was the PATH, not the data.
 */
import { describe, it, expect } from "vitest";
import {
  lookupContextPath,
  parseContextPath,
  resolveReferencePath,
} from "../context-path.js";
import { resolveTemplate } from "../template-resolve.js";
import { evaluateCondition } from "../condition-eval.js";
import { beginStepDiagnostics } from "../unresolved-references.js";
import type { StepContext } from "../automation-executor-types.js";

const emptyContext = (): StepContext => ({
  trigger: { payload: {} },
  steps: {},
  automation: { id: "a1", state: {} },
});

describe("parseContextPath grammar", () => {
  it('parses bare dot paths exactly as the old split(".") did', () => {
    expect(parseContextPath("steps.query1.output.count")).toEqual([
      "steps",
      "query1",
      "output",
      "count",
    ]);
  });

  it("parses double-, single-quoted and numeric bracket segments", () => {
    expect(parseContextPath('steps["query-1"].output')).toEqual([
      "steps",
      "query-1",
      "output",
    ]);
    expect(parseContextPath("steps['query-1'].output")).toEqual([
      "steps",
      "query-1",
      "output",
    ]);
    expect(parseContextPath('steps["query-1"].output.entities[0].id')).toEqual([
      "steps",
      "query-1",
      "output",
      "entities",
      "0",
      "id",
    ]);
  });

  it("rejects a malformed bracket instead of guessing", () => {
    // Unterminated, unquoted-non-numeric, and an empty segment. All null →
    // the caller records miss:"missing", which is what the dot-split produced
    // for a junk path too, so no previously-resolving path changes meaning.
    expect(parseContextPath('steps["query-1"')).toBeNull();
    expect(parseContextPath("steps[query-1].output")).toBeNull();
    expect(parseContextPath("steps..output")).toBeNull();
    expect(parseContextPath("")).toBeNull();
  });
});

describe("lookupContextPath with brackets", () => {
  it('A NUMERIC INDEX IS AN ARRAY INDEX (it is the key "0", same as `a.0`)', () => {
    const context = {
      ...emptyContext(),
      steps: {
        "query-1": { output: { entities: [{ id: "e1" }, { id: "e2" }] } },
      },
    };
    expect(
      lookupContextPath('steps["query-1"].output.entities[1].id', context)
    ).toEqual({ value: "e2", miss: null });
    // Out of range misses, exactly like an absent object key.
    expect(
      lookupContextPath('steps["query-1"].output.entities[9]', context).miss
    ).toBe("missing");
  });

  it('still records miss:"missing" for an unresolvable bracket path', () => {
    // The diagnostic is what made this defect findable — it must survive.
    const collector = beginStepDiagnostics();
    resolveReferencePath('steps["nope"].output.count', emptyContext());
    expect(collector.list()).toEqual([
      { path: 'steps["nope"].output.count', reason: "missing", count: 1 },
    ]);
  });
});

describe("run 4c42a659 replay — Event Prep Briefing, 5 entities", () => {
  // The shape the `query-1` node recorded on the live run: `select` default
  // returns both the rows and their count.
  const context = (): StepContext => ({
    ...emptyContext(),
    steps: {
      "query-1": {
        output: {
          count: 5,
          entities: [
            { id: "ev1", name: "Event 1" },
            { id: "ev2", name: "Event 2" },
            { id: "ev3", name: "Event 3" },
            { id: "ev4", name: "Event 4" },
            { id: "ev5", name: "Event 5" },
          ],
        },
      },
    },
  });

  it('condition-1: `steps["query-1"].output.count > 0` is TRUE (was false)', () => {
    expect(
      evaluateCondition('steps["query-1"].output.count > 0', context())
    ).toBe(true);
  });

  it("condition-1 is still FALSE on the 0-result run (41ac1b09), by DATA not by miss", () => {
    const zero = context();
    zero.steps["query-1"] = { output: { count: 0, entities: [] } };
    const collector = beginStepDiagnostics();
    expect(evaluateCondition('steps["query-1"].output.count > 0', zero)).toBe(
      false
    );
    expect(collector.list()).toEqual([]);
  });

  it('loop-1: `steps["query-1"].output.entities` yields the 5 rows (was `undefined` → [])', () => {
    const items = resolveReferencePath(
      'steps["query-1"].output.entities',
      context()
    );
    expect(Array.isArray(items)).toBe(true);
    expect(items as unknown[]).toHaveLength(5);
  });

  it('interpolation of a bracket path renders the value, not ""', () => {
    expect(
      resolveTemplate('{{steps["query-1"].output.count}} events', context())
    ).toBe("5 events");
  });

  it("a bracket path on the RIGHT of a comparison resolves too", () => {
    const c = context();
    c.trigger.payload = { count: 5 };
    expect(
      evaluateCondition(
        'trigger.payload.count === steps["query-1"].output.count',
        c
      )
    ).toBe(true);
  });
});
