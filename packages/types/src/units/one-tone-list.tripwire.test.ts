/**
 * ONE list of tone tokens: `UNIT_TONES` in `./state.ts`.
 *
 * `lifecycle/option.ts` once kept its own copy of the eight tokens to check an
 * authored tone, beside the `UnitTone` union it had to agree with by hand.
 * This scan fails when any other non-test source file in `@synap-core/types`
 * spells all eight tokens as string literals within one block (a list, a
 * union, a table keyed by tone).
 *
 * WHAT IT CANNOT SEE: a copy split across distant lines (the window is 600
 * characters), a copy that leaves out one token, or a copy in another repo.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UNIT_TONES } from "./state.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = "units/state.ts";
const WINDOW = 600;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.includes(".test.") ? [path] : [];
  });
}

/** True when every tone token appears as a literal inside one window. */
export function spellsEveryTone(source: string): boolean {
  const at = (t: string) =>
    [...source.matchAll(new RegExp(`["']${t}["']`, "g"))].map((m) => m.index!);
  const hits = UNIT_TONES.map(at);
  if (hits.some((h) => h.length === 0)) return false;
  return hits[0]!.some((start) =>
    hits.every((h) => h.some((i) => i >= start - WINDOW && i <= start + WINDOW))
  );
}

describe("one tone list", () => {
  const files = sources(SRC);

  it("scans the package (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(200);
    // The detector still sees the one real list.
    expect(spellsEveryTone(readFileSync(join(SRC, HOME), "utf8"))).toBe(true);
  });

  it("no source but state.ts spells every tone token", () => {
    const copies = files
      .filter((f) => relative(SRC, f) !== HOME)
      .filter((f) => spellsEveryTone(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(copies).toEqual([]);
  });
});
