/**
 * T10 — QUERY ABUSE on the collection door (collection door C1b): every knob
 * is bounded and allowlisted, decided by the ONE pure parser
 * `parseCollectionQuery` (the route passes `c.req.queries()` verbatim).
 *
 * Pinned:
 *   - `limit` clamps to 1..100 (default: the collection's page size);
 *   - `offset` is 0..10 000; beyond → "offset too large"; not digits → 400;
 *   - `sort` is ≤ 3 keys out of EXACTLY the configured sort keys ∪
 *     `publishedAt`; a repeated key, an unknown key, a key smuggling SQL or a
 *     JSON path → 400; default = the configured sort, else `-publishedAt`;
 *   - `ref[…]` and `embed` are not available yet (C1c): refused, never
 *     silently ignored;
 *   - a knob given twice is refused; unknown params are ignored.
 * The rate class of `/public/sites/*` is pinned in apps/api
 * `public-doors.tripwire.test.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  parseCollectionQuery,
  SITE_MAX_LIMIT,
  SITE_MAX_OFFSET,
} from "../public-site-read.js";

const COLLECTION = { sort: ["-year", "title"], pageSize: 20 };
const parse = (
  q: Record<string, string | string[]>,
  collection: { sort: readonly string[]; pageSize: number } = COLLECTION
) =>
  parseCollectionQuery(
    Object.fromEntries(
      Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? v : [v]])
    ),
    collection
  );

describe("T10: limit and offset are bounded", () => {
  it("defaults: offset 0, the page size, the configured sort", () => {
    expect(parse({})).toEqual({
      offset: 0,
      limit: 20,
      sort: [
        { key: "year", desc: true },
        { key: "title", desc: false },
      ],
    });
  });

  it.each([
    ["0", 1],
    ["1", 1],
    ["100", 100],
    ["101", SITE_MAX_LIMIT],
    ["999999999", SITE_MAX_LIMIT],
  ])("limit=%s → %i", (raw, limit) => {
    expect(parse({ limit: raw })).toMatchObject({ limit });
  });

  it.each(["-1", "1.5", "abc", "", "1e3", "0x10", "1234567890"])(
    "limit=%j → 400",
    (raw) => {
      expect(parse({ limit: raw })).toEqual({ invalid: "invalid limit" });
    }
  );

  it("offset 0..10 000; beyond → offset too large", () => {
    expect(parse({ offset: String(SITE_MAX_OFFSET) })).toMatchObject({
      offset: SITE_MAX_OFFSET,
    });
    expect(parse({ offset: String(SITE_MAX_OFFSET + 1) })).toEqual({
      invalid: "offset too large",
    });
    for (const raw of ["-1", "x", "1.0", ""]) {
      expect(parse({ offset: raw })).toEqual({ invalid: "invalid offset" });
    }
  });
});

describe("T10: sort is allowlisted", () => {
  it("configured keys and publishedAt, ascending or descending, ≤ 3", () => {
    expect(parse({ sort: "title,-publishedAt,year" })).toMatchObject({
      sort: [
        { key: "title", desc: false },
        { key: "publishedAt", desc: true },
        { key: "year", desc: false },
      ],
    });
  });

  it.each([
    "venue", // a snapshot field that is not a configured sort key
    "year,title,publishedAt,year", // > 3
    "year,-year", // the same key twice
    "title;drop table x",
    "properties->>'title'",
    "-",
    "",
    "title,",
    "__proto__",
  ])("sort=%j → 400", (raw) => {
    expect(parse({ sort: raw })).toEqual({ invalid: "invalid sort" });
  });

  it("no configured sort → -publishedAt by default, and only publishedAt is sortable", () => {
    const bare = { sort: [], pageSize: 5 };
    expect(parse({}, bare)).toEqual({
      offset: 0,
      limit: 5,
      sort: [{ key: "publishedAt", desc: true }],
    });
    expect(parse({ sort: "title" }, bare)).toEqual({ invalid: "invalid sort" });
  });
});

describe("T10: everything else", () => {
  it.each([
    [{ embed: "authors" }, "embed is not available"],
    [{ "ref[authors]": "p_AAAABBBBCCCCDDDD" }, "ref filter is not available"],
    [{ ref: "x" }, "ref filter is not available"],
  ] as Array<[Record<string, string>, string]>)(
    "%j → 400 (C1c, never silently ignored)",
    (q, invalid) => {
      expect(parse(q)).toEqual({ invalid });
    }
  );

  it("a knob given twice is refused", () => {
    expect(parse({ limit: ["1", "2"] })).toEqual({ invalid: "invalid limit" });
    expect(parse({ offset: ["1", "2"] })).toEqual({
      invalid: "invalid offset",
    });
    expect(parse({ sort: ["title", "year"] })).toEqual({
      invalid: "invalid sort",
    });
  });

  it("an unknown param is ignored", () => {
    expect(parse({ utm_source: "x", page: "2" })).toMatchObject({
      offset: 0,
      limit: 20,
    });
  });
});
