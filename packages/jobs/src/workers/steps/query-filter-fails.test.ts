/**
 * A `query` step whose filter cannot be read FAILS; it never matches everything.
 *
 * The parser used to read a string filter that did not JSON-parse after
 * templating as "no filter" (`catch { filterObj = undefined }`), so the step
 * returned EVERY row of the kind and reported success. Feed that into an
 * `entity_update` and a typo updates the whole kind. A failed read is not an
 * empty filter: the step now throws `QueryFilterParseError`, which the step
 * runner records as `failed` with its message.
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

  it("no filter is still no filter: absent, empty and all-missing templates run unfiltered", async () => {
    await expect(run(undefined)).resolves.toEqual({ entities: [], count: 0 });
    await expect(run("")).resolves.toEqual({ entities: [], count: 0 });
    // A whole-filter template with nothing behind it renders "" (the
    // template engine's "no steer given"), which is no filter, not a typo.
    await expect(run("{{trigger.payload.filter}}")).resolves.toEqual({
      entities: [],
      count: 0,
    });
    expect(mocks.selects).toBe(3);
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
