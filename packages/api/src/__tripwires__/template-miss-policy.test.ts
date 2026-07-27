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

// The parser defines both doors; its own file is where `.substitute(` lives.
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
