/**
 * The "how to" for the intent vocabulary is REACHABLE, not merely written.
 *
 * WHY THIS EXISTS. The founder's instruction was "we need to collapse once & for
 * all, and store that 'how to' on synap so agents remember." A chapter that sits in
 * `skills/` is only "remembered" if an agent is actually pointed at it, and the
 * default failure is quiet: a `.md` file nobody references reads exactly like
 * documentation that works. The chapter existed and was still undiscoverable — so
 * this asserts the three things that make it reachable, and nothing more.
 *
 * SCOPE, MEASURED — what this does NOT cover:
 * - It proves the files and the pointers exist. It CANNOT prove an agent reads
 *   them or obeys them; that is the same limit every prose guard in this
 *   directory carries, and it is stated in each rather than implied.
 * - It checks the `synap-schema` package only. If the chapter were deleted and
 *   re-added under a different package, this would go quiet — it pins THIS
 *   package's `_order.txt`, not the concept's home in general.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../skills"
);
const PKG = join(ROOT, "synap-schema");
const CHAPTER = "intent-vocabulary-ssot.md";

describe("the intent-vocabulary 'how to' is reachable", () => {
  it("NON-VACUITY: the scan found a real skill package with a real chapter list", () => {
    // A scan matching zero chapters would pass every assertion below for the
    // wrong reason — the same vacuous-pass failure this directory exists to catch.
    const order = readFileSync(join(PKG, "_order.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(order.length).toBeGreaterThanOrEqual(10);
    expect(existsSync(join(PKG, "SKILL.md"))).toBe(true);
  });

  it("the chapter exists AND is listed in _order.txt", () => {
    // `_order.txt` is what assembles the package for delivery (see
    // skills/manifest.json — the CLI installs baseline by default). A chapter
    // missing from it is a file on disk that no installed agent ever receives,
    // which is the quietest possible way to fail to document something.
    expect(existsSync(join(PKG, CHAPTER))).toBe(true);
    const order = readFileSync(join(PKG, "_order.txt"), "utf8");
    expect(order).toMatch(new RegExp(`^${CHAPTER.replace(".", "\\.")}$`, "m"));
  });

  it("SKILL.md carries it, so an agent actually receives it", () => {
    // ⚠️ SKILL.md IS A GENERATED BUNDLE (`skills/build.mjs` assembles it from
    // `_order.txt`), so it does NOT link the chapter by a `system/…` slug — it
    // INLINES the chapter's body. An earlier version of this test asserted that
    // pointer and went red the moment the bundle was rebuilt: the guard doing its
    // job on a wrong assertion. Reachability here means the CONTENT ships in the
    // bundle an agent downloads, so that is what is asserted — via a line only
    // this chapter states, not merely the word "intent".
    const skill = readFileSync(join(PKG, "SKILL.md"), "utf8");
    // Non-vacuity: the scan can still see a heading of the shape it hunts.
    expect(skill).toMatch(/^## /m);
    expect(skill).toMatch(/THE SOURCE OF TRUTH IS A TABLE, NOT A UNION/);
    expect(skill).toMatch(/capability_intents/);
    // And the TRIGGERS an agent would actually hit — naming the field names is
    // what makes the match happen, more than the heading does.
    for (const trigger of [
      "intent",
      "provides",
      "taskIntents",
      "requiredIntents",
    ]) {
      expect(skill).toMatch(new RegExp(trigger));
    }
  });

  it("every chapter named in _order.txt exists on disk", () => {
    // The reverse direction, and the one that generalises: a `_order.txt` naming a
    // file that is gone would make the package assembler fail (or, worse, silently
    // ship without it). Derived from the list, never hand-maintained.
    const order = readFileSync(join(PKG, "_order.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const missing = order.filter((f) => !existsSync(join(PKG, f)));
    expect(missing).toEqual([]);
  });

  it("the chapter states the SSOT, the constraints, and the steps — the three things that made the mirrors unavoidable", () => {
    const doc = readFileSync(join(PKG, CHAPTER), "utf8");
    // THE SSOT, named as a table (not "the union").
    expect(doc).toMatch(/capability_intents/);
    expect(doc).toMatch(/TABLE|table/);
    // The CONSTRAINTS that make three mirrors necessary — a reader who has not
    // felt these will "helpfully" collapse a mirror and reintroduce the bug.
    expect(doc).toMatch(/build cycle/i);
    expect(doc).toMatch(/deploy target/i);
    // The STEPS, including the two that are easy to miss and are the actual
    // failure modes: rebuilding `packages/types`, and updating the arity floor.
    expect(doc).toMatch(/pnpm build/);
    expect(doc).toMatch(/arity/i);
    // And the honest limits, so a future reader does not over-trust the guards.
    expect(doc).toMatch(/never CORRECTNESS/i);
    expect(doc).toMatch(/not auto-scanned/i);
    expect(doc.length).toBeGreaterThan(1500);
  });

  it("the chapter names all THREE mirrors by path (a fourth would be invisible otherwise)", () => {
    const doc = readFileSync(join(PKG, CHAPTER), "utf8");
    for (const path of [
      "packages/database/src/schema/tools.ts",
      "packages/types/src/capability-intents",
      "synap-control-plane-api/src/seeds/capability-intent-vocabulary.ts",
    ]) {
      expect(doc, `mirror path not documented: ${path}`).toContain(path);
    }
  });
});
