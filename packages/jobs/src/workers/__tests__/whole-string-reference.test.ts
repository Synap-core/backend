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
  parseQueryFilterConditions,
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

/**
 * The FOURTH call site — missed on the first pass, which is exactly why the
 * matcher is a shared named export instead of a regex re-typed per site.
 * `executeTransformStep` resolves the part BEFORE the first " | " separately;
 * that branch kept the old both-ends-anchored regex.
 */
describe("transform: multi-placeholder BEFORE the pipe", () => {
  it("interpolates the pre-pipe part instead of yielding undefined", () => {
    const out = executeTransformStep(
      { expression: "{{steps.a.output}} and {{steps.b.output}} | trim" },
      ctx({ a: { output: "first" }, b: { output: "second" } })
    );
    expect(out.result).toBe("first and second");
  });

  it("still passes a TRUE single reference through natively (array stays an array)", () => {
    const out = executeTransformStep(
      { expression: "{{steps.a.output}} | unique" },
      ctx({ a: { output: ["x", "x", "y"] } })
    );
    expect(out.result).toEqual(["x", "y"]);
  });
});

/**
 * The FILTER half of the same bug. `parseQueryOrderBy` was fixed to address
 * real `entities` columns; `parseQueryFilterConditions` shipped the identical
 * defect and kept it: EVERY operator compiled to
 * `entities.properties->>'<key>'`, so `filter: { updatedAt: { $gt: … } }`
 * looked up a jsonb key no entity carries and matched ZERO rows — with no
 * throw and step status SUCCESS. `gt/gte/lt/lte` made it worse by coercing
 * with `Number(value)`, which is `NaN` for every ISO-8601 date string.
 *
 * These tests assert BOTH directions: the new column path, AND that the two
 * legacy addressing forms (`properties.`-prefixed, and a bare unknown name)
 * still mean exactly what they meant before.
 */
describe("parseQueryFilterConditions: real columns vs jsonb properties", () => {
  it("resolves a bare date column and binds a real Date, not Number(value)", () => {
    const conditions = parseQueryFilterConditions(
      { profileSlug: "task", updatedAt: { $gte: "2026-07-01T00:00:00.000Z" } },
      ctx({})
    );
    expect(conditions).toHaveLength(1);
    const c = conditions[0] as { column: string; op: string; value: unknown };
    expect(c.column).toBe("updatedAt");
    expect(c.op).toBe("gte");
    expect(c.value).toBeInstanceOf(Date);
    expect((c.value as Date).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    // The old path produced Number("2026-07-01T…") === NaN.
    expect(Number.isNaN(Number(c.value))).toBe(false);
  });

  it("accepts epoch millis and a Date for a date column", () => {
    const ms = Date.UTC(2026, 6, 1);
    for (const raw of [ms, new Date(ms)]) {
      const [c] = parseQueryFilterConditions(
        { createdAt: { $lt: raw } },
        ctx({})
      ) as Array<{ column: string; value: unknown }>;
      expect(c.column).toBe("createdAt");
      expect((c.value as Date).getTime()).toBe(ms);
    }
  });

  it("DROPS a date-column term whose value will not parse — never a wrong comparison", () => {
    // Dropping widens the result set (visible); binding `Invalid Date` would
    // narrow it to zero rows silently, which is the bug class being fixed.
    expect(
      parseQueryFilterConditions(
        { updatedAt: { $gt: "last tuesday" } },
        ctx({})
      )
    ).toEqual([]);
    expect(parseQueryFilterConditions({ createdAt: true }, ctx({}))).toEqual(
      []
    );
  });

  it("resolves the bare text columns (title / type) to columns too", () => {
    const conditions = parseQueryFilterConditions(
      { title: "Weekly report", type: "task" },
      ctx({})
    );
    expect(conditions).toEqual([
      { column: "title", op: "eq", value: "Weekly report" },
      { column: "type", op: "eq", value: "task" },
    ]);
  });

  it("an explicit properties. prefix ALWAYS means jsonb, even for a column name", () => {
    // Same escape hatch as parseQueryOrderBy: a workspace whose entities
    // genuinely carry a property named `updatedAt` stays addressable.
    expect(
      parseQueryFilterConditions(
        { "properties.updatedAt": { $gt: 5 } },
        ctx({})
      )
    ).toEqual([{ propKey: "updatedAt", op: "gt", value: 5 }]);
  });

  it("an unknown bare name stays a jsonb property — existing flows unchanged", () => {
    expect(
      parseQueryFilterConditions(
        { strengthScore: { $gt: 30 }, status: "active" },
        ctx({})
      )
    ).toEqual([
      { propKey: "strengthScore", op: "gt", value: 30 },
      { propKey: "status", op: "eq", value: "active" },
    ]);
  });

  it("the legacy JSON-stringified flat filter keeps its jsonb meaning", () => {
    expect(
      parseQueryFilterConditions(
        JSON.stringify({ "properties.status": "active" }),
        ctx({})
      )
    ).toEqual([{ propKey: "status", op: "eq", value: "active" }]);
  });
});
