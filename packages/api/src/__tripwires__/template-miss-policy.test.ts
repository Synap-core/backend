import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — the command-template miss policy must have LIVE callers.
 *
 * `substituteWithMisses()` and `template-diagnostics.ts` exist because an
 * unresolved `@{arg:X}` renders as `""` and mutilates a prompt with no signal.
 * The policy was built, and then every production path kept calling plain
 * `substitute()` — so for its whole life it recorded misses that nobody read.
 * A diagnostic with zero callers is indistinguishable from not having one.
 *
 * This keeps the door shut from the other side: outside the parser itself,
 * api/src substitutes through `substituteWithMisses()` and does something with
 * what comes back. If this fails, you added a substitution site that drops its
 * misses on the floor — call `substituteWithMisses()` and log/surface
 * `authoringMisses(misses)`. Do NOT add your file to the allowlist.
 *
 * NOTE ON THE VALUE: the policy is about SILENCE, not about the substituted
 * text. Absent still resolves to `""` — flows depend on that. Changing that is
 * a different (and much larger) decision.
 */

// The parser defines both doors, so its own file is the one place a reference to
// the silent door is legitimate. NOTE: it does not currently MATCH `BANNED` —
// command-template.ts:414 invokes the closure bare (`substitute(argValues, …)`),
// not as `.substitute(`. The entry is kept deliberately (this file may always
// reach its own door), not because it is currently offending.
const ALLOWLIST = new Set<string>(["utils/command-template.ts"]);

/**
 * A call to the silent door on a parsed template. Comment lines are excluded —
 * `template-diagnostics.ts` legitimately NAMES `substitute()` in the prose that
 * explains why the policy exists.
 */
const BANNED = ".substitute(";

function callsSilentDoor(src: string): boolean {
  return src.split("\n").some((line) => {
    const t = line.trim();
    if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) {
      return false;
    }
    return t.includes(BANNED);
  });
}

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

describe("tripwire: template misses are never dropped in production", () => {
  it("no api/src file calls the silent substitute() outside the parser", () => {
    const srcRoot = join(process.cwd(), "src");
    const offenders = tsFiles(srcRoot)
      .filter((f) => callsSilentDoor(readFileSync(f, "utf8")))
      .map((f) => relative(srcRoot, f))
      .filter((rel) => !ALLOWLIST.has(rel));
    expect(offenders).toEqual([]);
  });

  /*
   * The three assertions below exist because the test ABOVE was VACUOUS.
   *
   * `.substitute(` currently occurs ZERO times in the scanned corpus — not in
   * the allowlisted parser, not anywhere in api/src outside `.test.ts` files.
   * So "no offenders" was not evidence that callers comply; it was evidence
   * that the watched pattern no longer occurs at all. A guard reporting green
   * because it has nothing to guard is indistinguishable from a guard that
   * works, and it stays green through exactly the change it exists to catch:
   * rename the door, or let the detector rot, and it certifies compliance
   * forever. Assert the corpus, the target, and the detector — the same shape
   * as `governed-writes-have-approval-half.test.ts` RULEs 2/3/4.
   */

  it("the scan walked a non-trivial corpus (not an empty/moved tree)", () => {
    const srcRoot = join(process.cwd(), "src");
    const files = tsFiles(srcRoot);
    expect(
      files.length,
      `Scanned only ${files.length} files under api/src — the tree moved or the ` +
        `walker broke, and the "no offenders" verdict above means nothing.`
    ).toBeGreaterThan(100);
  });

  it("the silent door still EXISTS under the watched name", () => {
    // If `substitute` is renamed, `.substitute(` can never match again and this
    // tripwire is dead while reading green. Pin the target: the door must still
    // be declared on ParsedTemplate. Renaming it is fine — but then BANNED and
    // this assertion must be retargeted together, which is the point.
    const parser = readFileSync(
      join(process.cwd(), "src", "utils", "command-template.ts"),
      "utf8"
    );
    // Scope to the ParsedTemplate INTERFACE body. A bare /substitute\(/ over the
    // whole file also matches line ~414, where substituteWithMisses() invokes the
    // closure internally — so renaming the public door would still have passed.
    // (Verified: that looser form did pass a rename mutation. Pin the contract.)
    const ifaceStart = parser.indexOf("export interface ParsedTemplate {");
    expect(
      ifaceStart,
      "ParsedTemplate interface not found — command-template.ts was restructured."
    ).toBeGreaterThan(-1);
    const iface = parser.slice(
      ifaceStart,
      parser.indexOf("\n}", ifaceStart) + 2
    );
    expect(
      /^\s{2}substitute\(/m.test(iface),
      "ParsedTemplate no longer DECLARES `substitute(` — the silent door was " +
        "renamed or removed. Retarget BANNED (and this assertion) at the new " +
        "name, or delete this tripwire if the door is genuinely gone. Do NOT " +
        "leave it scanning for a pattern that cannot occur."
    ).toBe(true);
    expect(/^\s{2}substituteWithMisses\(/m.test(iface)).toBe(true);
  });

  it("SELF-GUARD: the detector actually fires on a known positive", () => {
    // Reachability, not implementation. The offender scan can only be trusted
    // if `callsSilentDoor` still recognises a real call — and still ignores the
    // prose that legitimately names the door.
    expect(callsSilentDoor("const out = parsed.substitute(args);")).toBe(true);
    expect(callsSilentDoor("      return t.substitute({ a: 1 });")).toBe(true);
    expect(callsSilentDoor(" * explains why .substitute( is banned here")).toBe(
      false
    );
    expect(callsSilentDoor("// legacy: parsed.substitute(args)")).toBe(false);
    expect(callsSilentDoor("const out = substituteWithMisses(args);")).toBe(
      false
    );
  });

  it("the two live substitution paths are wired to the miss policy", () => {
    const srcRoot = join(process.cwd(), "src");
    for (const rel of [
      "services/playbooks/playbook-lifecycle.ts",
      "routers/intelligence.ts",
    ]) {
      const src = readFileSync(join(srcRoot, rel), "utf8");
      expect(src, rel).toContain("substituteWithMisses");
      expect(src, rel).toContain("authoringMisses");
    }
  });
});
