/**
 * Regression guard for the whole-string-reference matcher.
 *
 * THE BUG (live, 2026-07-27): the matcher was `/^\{\{(.+?)\}\}$/`. It reads as
 * "one non-greedy placeholder", but being anchored at BOTH ends it backtracks
 * until the trailing `\}\}` reaches the LAST `}}` in the string. So a genuine
 * interpolation — `"{{item.id}} · {{item.title}}"` — matched, and captured the
 * junk path `item.id}} · {{item.title`, which resolved to `undefined`.
 *
 * The damage was invisible: no throw, no warning, step status SUCCESS. In the
 * report automation every projection node emitted `[null, null, …]`, so three
 * AI rounds were handed empty lists and correctly reported that the workspace
 * contained no data — while the `query` steps upstream had returned 15 notes
 * and 25 tasks. Fetched, then destroyed in transit, silently.
 *
 * These tests assert BOTH directions, because a matcher that is merely stricter
 * would break the value bindings the engine depends on (`body:` handing native
 * markdown through, array inputs staying arrays).
 */
import { describe, it, expect } from "vitest";
import {
  matchWholeStringReference,
  deepResolveTemplates,
  executeTransformStep,
  executeGuardStep,
  parseQueryOrderBy,
  type StepContext,
} from "../automation-executor.js";

const ctx = (steps: Record<string, { output: unknown }>): StepContext =>
  ({
    trigger: { payload: {} },
    steps,
    automation: { id: "a1", state: {} },
  }) as unknown as StepContext;

describe("matchWholeStringReference", () => {
  it("matches a genuine whole-string value binding", () => {
    expect(matchWholeStringReference("{{steps.assemble.output}}")).toBe(
      "steps.assemble.output"
    );
  });

  it("REJECTS two placeholders separated by text — the live bug", () => {
    // The old regex matched this and captured `item.id}} · {{item.title`.
    expect(
      matchWholeStringReference("{{item.id}} · {{item.title}}")
    ).toBeNull();
  });

  it("rejects adjacent placeholders with no separator", () => {
    expect(matchWholeStringReference("{{a}}{{b}}")).toBeNull();
  });

  it("rejects a placeholder with leading or trailing text", () => {
    expect(matchWholeStringReference("Notes: {{a}}")).toBeNull();
    expect(matchWholeStringReference("{{a}} notes")).toBeNull();
  });
});

describe("map: projection over multiple placeholders", () => {
  const entities = [
    { id: "id-1", title: "First note" },
    { id: "id-2", title: "Second note" },
  ];

  it("interpolates each item instead of yielding nulls", () => {
    const out = executeTransformStep(
      {
        expression:
          "{{steps.gather-notes.output.entities}} | map: {{item.id}} · {{item.title}}",
      },
      ctx({ "gather-notes": { output: { entities, count: 2 } } })
    );
    expect(out.result).toEqual(["id-1 · First note", "id-2 · Second note"]);
  });

  it("still returns NATIVE values for a true single-reference map", () => {
    // Must not regress: a lone `{{item.id}}` yields the raw value, not a string
    // rendering of it — array inputs downstream depend on this.
    const out = executeTransformStep(
      { expression: "{{steps.g.output.entities}} | map: {{item.id}}" },
      ctx({ g: { output: { entities, count: 2 } } })
    );
    expect(out.result).toEqual(["id-1", "id-2"]);
  });
});

/**
 * The SECOND silent failure in the same run. `exists` is a NULL check, so the
 * report flow's guard — whose message read "refusing to write an empty report"
 * — passed an empty-string body straight through to the writer. The run went
 * green and the reader showed "Nothing written yet".
 */
describe("guard: exists vs minLength", () => {
  const guard =
    (checks: unknown[], steps: Record<string, { output: unknown }>) => () =>
      executeGuardStep({ checks } as never, ctx(steps));

  it("documents that `exists` does NOT reject an empty string", () => {
    // Not a bug in `exists` — it is a null check and this is what that means.
    // Pinned so nobody "fixes" it here and breaks flows that rely on presence.
    expect(
      guard([{ path: "steps.a.output", exists: true, message: "m" }], {
        a: { output: "" },
      })
    ).not.toThrow();
  });

  it("minLength REJECTS an empty body", () => {
    expect(
      guard([{ path: "steps.a.output", minLength: 200, message: "empty" }], {
        a: { output: "" },
      })
    ).toThrow();
  });

  it("minLength rejects a whitespace-only body", () => {
    expect(
      guard([{ path: "steps.a.output", minLength: 1, message: "empty" }], {
        a: { output: "   \n\t  " },
      })
    ).toThrow();
  });

  it("minLength rejects a body that is short but non-empty", () => {
    expect(
      guard([{ path: "steps.a.output", minLength: 200, message: "short" }], {
        a: { output: "# Report\n\nNothing to say." },
      })
    ).toThrow();
  });

  it("minLength rejects a non-string, non-array value rather than passing it", () => {
    expect(
      guard([{ path: "steps.a.output", minLength: 1, message: "obj" }], {
        a: { output: { error: "round failed" } },
      })
    ).toThrow();
  });

  it("minLength ACCEPTS a real body", () => {
    expect(
      guard([{ path: "steps.a.output", minLength: 200, message: "m" }], {
        a: { output: "x".repeat(250) },
      })
    ).not.toThrow();
  });

  it("minLength counts array length for arrays", () => {
    expect(
      guard([{ path: "steps.a.output", minLength: 2, message: "m" }], {
        a: { output: ["one"] },
      })
    ).toThrow();
    expect(
      guard([{ path: "steps.a.output", minLength: 2, message: "m" }], {
        a: { output: ["one", "two"] },
      })
    ).not.toThrow();
  });
});

describe("deepResolveTemplates value-binding vs interpolation", () => {
  const context = ctx({
    assemble: { output: "# Report\n\nbody" },
    n: { output: { result: 42 } },
  });

  it("passes a whole-string reference through NATIVELY", () => {
    // `entity_create.body` relies on this: the markdown must arrive unstringified.
    expect(deepResolveTemplates("{{steps.assemble.output}}", context)).toBe(
      "# Report\n\nbody"
    );
    expect(deepResolveTemplates("{{steps.n.output.result}}", context)).toBe(42);
  });

  it("interpolates a multi-placeholder string instead of nulling it", () => {
    expect(
      deepResolveTemplates(
        "{{steps.n.output.result}}/{{steps.n.output.result}}",
        context
      )
    ).toBe("42/42");
  });
});

/**
 * The THIRD instance of "silently wrong while looking correct" in one session.
 * `orderBy` could only address keys inside the `properties` jsonb, so
 * `orderBy: "updatedAt"` — a real COLUMN, never mirrored into properties —
 * evaluated `properties->>'updatedAt'`, got NULL for every row, and left the
 * result arbitrarily ordered with no error anywhere.
 */
describe("parseQueryOrderBy: real columns vs jsonb properties", () => {
  it("resolves a bare allowlisted name to the real COLUMN", () => {
    const r = parseQueryOrderBy({ orderBy: "updatedAt", orderDir: "desc" });
    expect(r?.kind).toBe("column");
    expect(r?.dir).toBe("desc");
  });

  it("resolves createdAt / title / type to columns too", () => {
    for (const key of ["createdAt", "title", "type"]) {
      expect(parseQueryOrderBy({ orderBy: key })?.kind).toBe("column");
    }
  });

  it("an explicit properties. prefix ALWAYS means jsonb, even for a column name", () => {
    // The disambiguation escape hatch: a workspace whose entities genuinely
    // carry a property named `updatedAt` must stay addressable.
    const r = parseQueryOrderBy({ orderBy: "properties.updatedAt" });
    expect(r).toEqual({ kind: "property", propKey: "updatedAt", dir: "desc" });
  });

  it("an unknown bare name stays a jsonb property — existing flows unchanged", () => {
    expect(parseQueryOrderBy({ orderBy: "score", orderDir: "asc" })).toEqual({
      kind: "property",
      propKey: "score",
      dir: "asc",
    });
  });

  it("does not order at all when orderBy is absent or not a string", () => {
    expect(parseQueryOrderBy({})).toBeUndefined();
    expect(parseQueryOrderBy({ orderBy: "   " })).toBeUndefined();
    expect(parseQueryOrderBy({ orderBy: 42 })).toBeUndefined();
  });
});
