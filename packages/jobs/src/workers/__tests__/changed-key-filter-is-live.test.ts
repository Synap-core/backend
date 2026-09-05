import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getNestedValue } from "../automation-trigger-matcher.js";

/**
 * `changed.<fieldName>` is ADVERTISED as a filter key — it must be READABLE.
 *
 * `entities/mutate.ts` writes the per-field change markers as FLAT keys
 * (`{"changed.status": true}`), while the matcher split every key on `.` and
 * looked for `data.changed.status`. The lookup returned `undefined`, the filter
 * failed closed, and a rule filtered on `changed.status` reported itself live
 * and never matched — while the event catalog, the picker description and the
 * heroui operator inference all advertised the key as usable.
 *
 * The payload SHAPE is read out of `mutate.ts`'s own source rather than
 * hand-written here. A synthetic fixture is exactly how this survived: any
 * fixture an author writes by hand will use the shape the author *believes* is
 * emitted, which is the belief that was wrong.
 */
describe("`changed.<field>` filters can actually be read", () => {
  const MUTATE = path.resolve(
    __dirname,
    "../../../../api/src/routers/entities/mutate.ts"
  );

  it("can see the emitter it claims to pin", () => {
    // Assert the path BEFORE any conclusion is drawn from reading it — a wrong
    // base path makes every content check answer `false`, and the suite would
    // then happily conclude "the emitter changed" from its own broken
    // arithmetic. This exact off-by-one happened writing this file.
    expect(fs.existsSync(MUTATE), `not found: ${MUTATE}`).toBe(true);
  });

  it("the emitter still writes the marker as a FLAT key", () => {
    const src = fs.readFileSync(MUTATE, "utf8");
    // The template literal that builds the key, inside an Object.fromEntries
    // whose result is SPREAD into `data` — i.e. top level, not nested.
    expect(
      /`changed\.\$\{k\}`/.test(src),
      "mutate.ts no longer emits `changed.${k}` — re-derive this test against " +
        "whatever it emits now, do not delete it."
    ).toBe(true);
    expect(
      /\.\.\.Object\.fromEntries\(/.test(src),
      "the markers are no longer spread flat into `data`; if they became a " +
        "nested `changed: {}` object the matcher's split path is correct again."
    ).toBe(true);
  });

  it("reads a flat dotted key", () => {
    // The literal payload shape mutate.ts produces.
    const data = {
      profileSlug: "person",
      changedKeys: ["status"],
      "changed.status": true,
    };
    expect(getNestedValue(data, "changed.status")).toBe(true);
  });

  it("still reads a genuinely nested path", () => {
    // The literal-first order must not break ordinary nested lookup.
    expect(getNestedValue({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
  });

  it("a literal key WINS over a nested path of the same name", () => {
    // Only one of these can be right, and the emitter writes the flat one.
    const data = { "a.b": "flat", a: { b: "nested" } };
    expect(getNestedValue(data, "a.b")).toBe("flat");
  });

  it("returns undefined for a key that is genuinely absent", () => {
    // Fail-closed must survive: a missing key is not a match.
    expect(getNestedValue({ x: 1 }, "changed.status")).toBeUndefined();
  });
});
