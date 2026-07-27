/**
 * Unresolved-reference diagnostics.
 *
 * CONTRACT UNDER TEST
 *  1. A `{{path}}` that resolves to nothing STILL renders "" — flows depend on
 *     it (an absent `{{trigger.payload.prompt}}` means "no steer given"), so the
 *     diagnostics must be additive and must never throw or fail a step.
 *  2. The same resolution is now RECORDED on the step's collector, separating
 *     "the path could not be walked" (`missing` — almost always a bug) from
 *     "the field exists and is null" (`null` — often legitimate).
 *  3. A path that resolves to a REAL value — including `""`, `0`, `false` — is
 *     NOT recorded. Those are values the author may have meant.
 *  4. Outside a step scope nothing is recorded and nothing breaks.
 *
 * This is the instrumentation for the 2026-07-27 silent-empty failure: the run
 * that reported "the workspace contains no data" while the pod held 706
 * entities. The wiring fault itself is covered by whole-string-reference.test.ts;
 * this file covers making such a fault VISIBLE.
 */

import { describe, it, expect } from "vitest";
import {
  UnresolvedReferenceCollector,
  withStepDiagnostics,
  MAX_PERSISTED_UNRESOLVED_REFS,
  UNRESOLVED_REFS_KEY,
} from "../unresolved-references.js";
import {
  resolveTemplate,
  deepResolveTemplates,
  type StepContext,
} from "../automation-executor.js";

const context = (): StepContext => ({
  trigger: { payload: { prompt: "", topic: "growth", nothing: null } },
  steps: { q1: { output: { items: [1, 2, 3] } } },
  automation: { id: "auto-1", state: {} },
});

/** Run `fn` inside a fresh step scope and hand back what it recorded. */
const collect = (fn: () => void) => {
  const collector = new UnresolvedReferenceCollector();
  withStepDiagnostics(collector, fn);
  return collector.list();
};

describe("unresolved-reference diagnostics", () => {
  it('records a path that cannot be walked as `missing`, and still renders ""', () => {
    let rendered: string | undefined;
    const refs = collect(() => {
      rendered = resolveTemplate("Items: {{steps.q9.output.items}}", context());
    });

    // (1) behavior unchanged — this is diagnostics, not an error.
    expect(rendered).toBe("Items: ");
    // (2) but no longer silent.
    expect(refs).toEqual([
      { path: "steps.q9.output.items", reason: "missing", count: 1 },
    ]);
  });

  it("separates a null-valued field (`null`) from a nonexistent path (`missing`)", () => {
    // Demonstrated on WIRING (`steps.*`), not on `trigger.payload.*`. The
    // payload is caller-supplied input whose absence is a normal input
    // condition, so it is deliberately not recorded at all — see
    // `isCallerSuppliedInput`. The taxonomy itself is unchanged; this is where
    // it now applies.
    const refs = collect(() => {
      resolveTemplate("{{steps.q1.output.blank}}|{{steps.q1.gone.deep}}", {
        trigger: { payload: {} },
        steps: { q1: { output: { blank: null } } },
        automation: { id: "auto-1", state: {} },
      } as never);
    });

    expect(refs).toEqual(
      expect.arrayContaining([
        { path: "steps.q1.output.blank", reason: "null", count: 1 },
        { path: "steps.q1.gone.deep", reason: "missing", count: 1 },
      ])
    );
    expect(refs).toHaveLength(2);
  });

  it('does NOT record references that resolve to a real value (including "")', () => {
    let rendered: string | undefined;
    const refs = collect(() => {
      // The report flow's STEER block: an EMPTY prompt is a legitimate value
      // meaning "no steer given" — flagging it would drown the real signal.
      rendered = resolveTemplate(
        "{{trigger.payload.prompt}}{{trigger.payload.topic}}",
        context()
      );
    });

    expect(rendered).toBe("growth");
    expect(refs).toEqual([]);
  });

  it("records the whole-string value-binding path used by deepResolveTemplates", () => {
    let bound: unknown;
    const refs = collect(() => {
      bound = deepResolveTemplates(
        { list: "{{steps.q1.output.missingField}}" },
        context()
      );
    });

    // Value bindings resolve to the native value — undefined here, as before.
    expect(bound).toEqual({ list: undefined });
    expect(refs).toEqual([
      { path: "steps.q1.output.missingField", reason: "missing", count: 1 },
    ]);
  });

  it("counts repeats instead of duplicating rows (a loop resolving the same bad ref per item)", () => {
    const refs = collect(() => {
      for (let i = 0; i < 5; i++)
        resolveTemplate("{{steps.q9.output.x}}", context());
    });

    expect(refs).toEqual([
      { path: "steps.q9.output.x", reason: "missing", count: 5 },
    ]);
  });

  it("caps the persisted list, keeping the most frequent offenders", () => {
    const collector = new UnresolvedReferenceCollector();
    for (let i = 0; i < MAX_PERSISTED_UNRESOLVED_REFS + 10; i++) {
      collector.record(`steps.q.output.f${i}`, "missing");
    }
    collector.record("steps.q.output.hot", "missing");
    collector.record("steps.q.output.hot", "missing");

    const refs = collector.list();
    expect(refs).toHaveLength(MAX_PERSISTED_UNRESOLVED_REFS);
    expect(refs[0]).toEqual({
      path: "steps.q.output.hot",
      reason: "missing",
      count: 2,
    });
  });

  it("is inert outside a step scope — resolution works, nothing is recorded", () => {
    // resolveTemplate is exported and called from tests and other workers; the
    // diagnostics must never change how those behave.
    expect(() =>
      resolveTemplate("{{steps.nope.output}}", context())
    ).not.toThrow();
    expect(resolveTemplate("{{steps.nope.output}}", context())).toBe("");
  });

  it("pins the reserved persistence key the run UI reads", () => {
    // Changing this string silently breaks every consumer of the step row.
    expect(UNRESOLVED_REFS_KEY).toBe("__unresolvedRefs");
  });
});

/**
 * The diagnostic must not fire on its own happy path. The report flow's STEER
 * block reads three `trigger.payload.*` keys in each of three AI rounds, and
 * running with NO steer is the documented default — so before this rule a
 * healthy report emitted nine "could not be resolved" warnings.
 */
describe("caller-supplied input is not a wiring fault", () => {
  it("does NOT record a missing trigger.payload key", () => {
    const refs = collect(() => {
      resolveTemplate("Prompt: {{trigger.payload.prompt}}", {
        trigger: { payload: {} },
        steps: {},
      } as never);
    });
    expect(refs).toEqual([]);
  });

  it("STILL records a missing steps.* wiring reference", () => {
    const refs = collect(() => {
      resolveTemplate("{{steps.nope.output.result}}", {
        trigger: { payload: {} },
        steps: {},
      } as never);
    });
    expect(refs.map((r) => r.path)).toEqual(["steps.nope.output.result"]);
  });

  it("records nothing for a whole steer block, but flags a typo'd step in the same string", () => {
    const refs = collect(() => {
      resolveTemplate(
        "{{trigger.payload.prompt}} {{trigger.payload.focus}} {{steps.gone.output}}",
        { trigger: { payload: {} }, steps: {} } as never
      );
    });
    expect(refs).toHaveLength(1);
    expect(refs[0].path).toBe("steps.gone.output");
  });
});
