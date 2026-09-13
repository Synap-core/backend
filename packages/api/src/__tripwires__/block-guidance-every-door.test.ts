/**
 * TRIPWIRE — every door that writes a slot's ownership carries the
 * work-guideline safety net, or is classified as deliberately not carrying it.
 *
 * The defect this exists for: an approved `governance.work_guideline` reached
 * NO agent, because nothing read `workKind` guidelines. The fix is ONE lookup
 * (`services/focus-sessions/block-guidelines.ts`) that every block door calls
 * so the response says "a guideline covers this". A door added tomorrow that
 * hands a slot to the human without it re-opens the silent approval.
 *
 * THE SET IS DERIVED, never hand-listed: a door is any non-test source file
 * under `src/` that CALLS one of the slot writers — `stampBlocked` (targeted
 * block), `applyOutputMutations` (addOutput / wholesale patch),
 * `mergeExpectedOutputs` (wholesale array merge), `sanitizeDeclaredOutputs`
 * (slots declared at create). Every such file must call
 * `guidanceForBlockedSlots(`, or appear in WITHHELD with its reason.
 *
 * WHAT THIS DOES NOT SEE, measured and stated:
 *   - Granularity is the FILE, not the call site. `update-session.ts` both
 *     defines writers and calls the net once; a second door function added to
 *     that same file without the call would stay green.
 *   - A door that writes `expectedOutputs` without going through any of the
 *     four writers (a raw `.set({ expectedOutputs })`) is invisible here.
 *   - Comments are stripped with a regex that does not understand strings; a
 *     `//` inside a string literal truncates that line for the scan.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const API_SRC = join(__dirname, "..");

const WRITER_CALL =
  /(?<!function\s)\b(stampBlocked|applyOutputMutations|mergeExpectedOutputs|sanitizeDeclaredOutputs)\s*\(/;
const NET_CALL = /(?<!function\s)\bguidanceForBlockedSlots\s*\(/;

/** Files that write slot ownership but deliberately do NOT carry the net. */
const WITHHELD: Record<string, string> = {
  "routers/focus-sessions.ts":
    "tRPC — the PERSON's own editor (protectedProcedure on their own session). " +
    "Its `blockOutput` still runs the net inside `blockExpectedOutput`; the " +
    "result is not forwarded because no agent reads this response, and " +
    "widening a tRPC output moves the committed api-types snapshot.",
  "routers/proposals/executors/focus-session.ts":
    "The approval executor re-applies a patch a HUMAN just approved; there is " +
    "no agent response to annotate at that moment.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (
        name === "node_modules" ||
        name === "dist" ||
        name === "__tests__" ||
        name === "__tripwires__"
      )
        continue;
      walk(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const doors = walk(API_SRC)
  .map((abs) => ({
    rel: relative(API_SRC, abs),
    code: stripComments(readFileSync(abs, "utf8")),
  }))
  .filter((f) => WRITER_CALL.test(f.code));

describe("block guidance — every slot-ownership door carries the net", () => {
  it("the scan can still see what it hunts (self-check)", () => {
    expect(WRITER_CALL.test("x = mergeExpectedOutputs(a, b)")).toBe(true);
    expect(WRITER_CALL.test("export function mergeExpectedOutputs(")).toBe(
      false
    );
    expect(NET_CALL.test("await guidanceForBlockedSlots({")).toBe(true);
    expect(stripComments("a // guidanceForBlockedSlots(")).not.toMatch(
      NET_CALL
    );
  });

  it("the derived door set is non-vacuous and contains the known doors", () => {
    const rels = doors.map((d) => d.rel);
    expect(rels.length).toBeGreaterThanOrEqual(5);
    for (const known of [
      "services/focus-sessions/block-output.ts",
      "services/focus-sessions/update-session.ts",
      "services/focus-sessions/create-session.ts",
      "routers/hub-protocol/rest/focus-sessions.ts",
    ]) {
      expect(rels).toContain(known);
    }
  });

  it("every door calls guidanceForBlockedSlots or is classified WITHHELD", () => {
    const uncovered = doors
      .filter((d) => !NET_CALL.test(d.code) && !(d.rel in WITHHELD))
      .map((d) => d.rel);
    expect(uncovered).toEqual([]);
  });

  it("every WITHHELD entry is still a door (no stale exemptions)", () => {
    const rels = new Set(doors.map((d) => d.rel));
    expect(Object.keys(WITHHELD).filter((k) => !rels.has(k))).toEqual([]);
  });
});
