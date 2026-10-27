/**
 * A `query` step whose filter cannot be read FAILS; it never matches everything.
 *
 * Read as "no filter", an unreadable filter returns EVERY row of the kind and
 * reports success; feed that into an `entity_update` and a typo updates the
 * whole kind. A failed read is not an empty filter: the step throws
 * `QueryFilterParseError`, which the step runner records as `failed` with its
 * message. Unreadable = a string that is not a JSON object after templating,
 * a template that renders to nothing, or a value that is neither an object nor
 * a string.
 *
 * The db is mocked, so this locks control flow: a bad filter rejects BEFORE any
 * SELECT is issued; an absent or empty filter still runs (no filter is a real
 * answer, not a failure).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StepContext } from "../automation-executor-types.js";

const mocks = vi.hoisted(() => ({ selects: 0 }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const rows = Promise.resolve([]);
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => rows,
  };
  return {
    ...actual,
    db: {
      select: () => {
        mocks.selects++;
        return query;
      },
    },
  };
});

import { executeQueryStep } from "./query.js";
import {
  parseQueryFilterConditions,
  QueryFilterParseError,
} from "../query-dsl.js";

const ctx = (payload: Record<string, unknown> = {}): StepContext =>
  ({
    trigger: { payload, subject: null },
    steps: {},
    automation: { id: "a1", state: {} },
  }) as StepContext;

const run = (filter: string | undefined, payload = {}) =>
  executeQueryStep(
    { profileSlug: "deal", filter, limit: 10 },
    ctx(payload),
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  );

beforeEach(() => {
  mocks.selects = 0;
});

describe("query step: a filter that cannot be read fails the step", () => {
  it("a filter that is not JSON rejects with QueryFilterParseError and queries nothing", async () => {
    await expect(run('{"status": "open"')).rejects.toBeInstanceOf(
      QueryFilterParseError
    );
    expect(mocks.selects).toBe(0);
  });

  it("a templated filter that breaks JSON once resolved rejects too", async () => {
    // `{{trigger.payload.stage}}` resolves to text with a quote in it.
    await expect(
      run('{"stage": "{{trigger.payload.stage}}"}', { stage: 'say "hi"' })
    ).rejects.toThrow(/not valid JSON after templating.*unfiltered/);
    expect(mocks.selects).toBe(0);
  });

  it("a filter that parses to something other than an object rejects", () => {
    for (const filter of ["null", "[1]", "42", '"open"']) {
      expect(() => parseQueryFilterConditions(filter, ctx())).toThrow(
        QueryFilterParseError
      );
    }
  });

  it('a template that renders to nothing rejects: a missing key is not "no filter"', async () => {
    // `resolveTemplate` renders a missing `{{trigger.payload.filter}}` as "".
    await expect(run("{{trigger.payload.filter}}")).rejects.toThrow(
      /is empty after templating.*unfiltered/
    );
    expect(() =>
      parseQueryFilterConditions(
        "{{trigger.payload.a}}{{trigger.payload.b}}",
        ctx()
      )
    ).toThrow(QueryFilterParseError);
    expect(mocks.selects).toBe(0);
  });

  it("a filter that is neither an object nor a string rejects", () => {
    for (const filter of [[], [{ stage: "won" }], 42, 0, true, false]) {
      expect(() => parseQueryFilterConditions(filter, ctx())).toThrow(
        /must be an object or a JSON string/
      );
    }
  });

  it("no filter is still no filter: absent and empty run unfiltered", async () => {
    await expect(run(undefined)).resolves.toEqual({ entities: [], count: 0 });
    await expect(run("")).resolves.toEqual({ entities: [], count: 0 });
    expect(parseQueryFilterConditions(null, ctx())).toEqual([]);
    expect(parseQueryFilterConditions("   ", ctx())).toEqual([]);
    expect(mocks.selects).toBe(2);
  });

  it("a filter that parses runs the query with its conditions", async () => {
    expect(
      parseQueryFilterConditions('{"stage": "{{trigger.payload.stage}}"}', {
        ...ctx({ stage: "won" }),
      })
    ).toEqual([{ propKey: "stage", op: "eq", value: "won" }]);
    await expect(
      run('{"stage": "{{trigger.payload.stage}}"}', { stage: "won" })
    ).resolves.toEqual({ entities: [], count: 0 });
    expect(mocks.selects).toBe(1);
  });
});
