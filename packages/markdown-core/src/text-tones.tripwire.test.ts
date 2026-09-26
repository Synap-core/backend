/**
 * TRIPWIRE — the tones a document may name are the design tokens' tones.
 *
 * `TEXT_TONES` cannot import the token package (synap-app) from this published
 * backend package, so the tone FAMILY is derived here from its two sources of
 * truth and every member must be classified:
 *   - the token JSON: each `tone-<slug>-fill` with a `tone-<slug>-ink` pair;
 *   - `UnitTone`, the type the pair family is keyed by (types/units/state.ts).
 * A tone in either that is neither in `TEXT_TONES` nor `WITHHELD_TEXT_TONES`
 * fails here; so does a listed tone with no token pair (a document would name
 * a colour no surface can paint).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEXT_TONES, WITHHELD_TEXT_TONES } from "./inline-format.js";

const MONOREPO = join(import.meta.dirname, "..", "..", "..", "..");
const TOKENS = join(
  MONOREPO,
  "synap-app/packages/core/design-tokens/src/tokens/color.tokens.json"
);
const UNIT_STATE = join(
  MONOREPO,
  "synap-backend/packages/types/src/units/state.ts"
);

const camel = (s: string) =>
  s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function tokenTones(): string[] {
  const keys: string[] = [];
  const walk = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      keys.push(k);
      walk(v);
    }
  };
  walk(JSON.parse(readFileSync(TOKENS, "utf8")));
  const fills = keys
    .map((k) => /^tone-(.+)-fill$/.exec(k)?.[1])
    .filter((s): s is string => !!s);
  return fills.filter((s) => keys.includes(`tone-${s}-ink`)).map(camel);
}

function unitTones(): string[] {
  const src = readFileSync(UNIT_STATE, "utf8");
  const union = /export type UnitTone\s*=([^;]+);/.exec(src)?.[1] ?? "";
  return [...union.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!);
}

// The token package lives in a sibling repo; absent ⇒ SKIPPED, never green.
const HAVE_TOKENS = existsSync(TOKENS);

describe.skipIf(!HAVE_TOKENS)("tripwire: document tones = token tones", () => {
  const family = [...new Set([...tokenTones(), ...unitTones()])].sort();
  const classified = new Set([
    ...TEXT_TONES,
    ...Object.keys(WITHHELD_TEXT_TONES),
  ]);

  it("non-vacuous: both sources are read", () => {
    expect(tokenTones()).toEqual(expect.arrayContaining(["info", "textMuted"]));
    expect(unitTones()).toEqual(expect.arrayContaining(["primary", "ai"]));
    expect(family.length).toBeGreaterThanOrEqual(8);
  });

  it("every token tone is allowed or withheld with a reason", () => {
    expect(family.filter((t) => !classified.has(t))).toEqual([]);
    for (const reason of Object.values(WITHHELD_TEXT_TONES))
      expect(reason.length).toBeGreaterThan(20);
  });

  it("every allowed tone has a fill AND an ink token", () => {
    const paired = new Set(tokenTones());
    expect(TEXT_TONES.filter((t) => !paired.has(t))).toEqual([]);
  });

  it("nothing is both allowed and withheld, and no stale entry", () => {
    expect(TEXT_TONES.filter((t) => t in WITHHELD_TEXT_TONES)).toEqual([]);
    expect([...classified].filter((t) => !family.includes(t))).toEqual([]);
  });
});
