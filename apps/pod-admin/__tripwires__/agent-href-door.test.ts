import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../scripts/strip-comments.mjs";

/**
 * "Open this agent" has ONE spelling in pod admin: `agentHref(id)`
 * (`lib/console-nav.ts`), the agent's console page `/agents/:id` (founder,
 * 2026-11-03: an agent has its own page, like a computer, instead of the
 * `/open/agent/:id` receiver card). Before it, the console opened an agent
 * three ways: the receiver card through `openIn({ kind: "object", objectKind:
 * "agent" })` (Agents, Agents & work), a focused row `navHref("agents",
 * { focus })` (a computer's agents, search), and a hand-built path.
 *
 * Scanned, in every non-test source file of the app (walked, never listed):
 *   1. a string that starts `/open/agent` — the receiver path built by hand
 *      (the one door that spells `/open/<kind>` is `openIn`);
 *   2. `navHref("agents", { focus … })` — an agent opened as a list row;
 *   3. in a CONSOLE page (`app/(admin)/**`), `openIn({ kind: "object",
 *      objectKind: "agent" })` — the receiver card from inside the console.
 *      A body drawn in both frames (`app/_lib/object/views/*`) still goes
 *      through `openIn`, which lands a pod admin here by `openRedirect`.
 */

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "__tripwires__",
  ".turbo",
  "coverage",
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.test\.tsx?$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
      out.push(full);
    }
  };
  walk(APP_ROOT);
  return out;
}

const HAND_BUILT = /["'`]\/open\/agent\b/g;
const FOCUSED_ROW = /navHref\(\s*["']agents["']\s*,\s*\{[^}]*\bfocus\b/g;
const OBJECT_LITERAL = /\{[^{}]*\bobjectKind:\s*["']agent["'][^{}]*\}/g;

/** Each way `src` opens an agent other than `agentHref`. */
export function agentLinkForks(src: string, consolePage: boolean): string[] {
  const code = stripComments(src, "ts");
  const out: string[] = [];
  for (const m of code.matchAll(HAND_BUILT)) out.push(`hand-built ${m[0]}`);
  for (const _ of code.matchAll(FOCUSED_ROW)) out.push("focused row");
  if (consolePage) {
    for (const m of code.matchAll(OBJECT_LITERAL)) {
      if (/\bkind:\s*["']object["']/.test(m[0])) out.push("receiver card");
    }
  }
  return out;
}

const isConsolePage = (file: string) =>
  relative(APP_ROOT, file).startsWith(`app${sep}(admin)${sep}`);

describe("an agent opens on its page through agentHref only", () => {
  it("the scan sees each fork, and not the door or prose (fixture)", () => {
    const fixture = [
      "const a = `/open/agent/${id}`;",
      'const b = navHref("agents", { focus: id });',
      "const c = openIn({",
      '  kind: "object",',
      '  objectKind: "agent",',
      "  id,",
      "}).href;",
      'const d = openIn({ kind: "objectInApp", objectKind: "agent", id });',
      "const e = agentHref(id);",
      'const f = navHref("agents");',
      '// `/open/agent/:id` is the receiver; navHref("agents", { focus })',
    ].join("\n");
    expect(agentLinkForks(fixture, true)).toEqual([
      "hand-built `/open/agent",
      "focused row",
      "receiver card",
    ]);
    // Outside the console a body may name the receiver through `openIn`.
    expect(agentLinkForks(fixture, false)).toEqual([
      "hand-built `/open/agent",
      "focused row",
    ]);
  });

  it("no pod-admin source opens an agent any other way", () => {
    const files = sourceFiles();
    const consolePages = files.filter(isConsolePage);
    // Non-vacuity: the walk reaches the app and its console pages.
    expect(files.length).toBeGreaterThan(200);
    expect(consolePages.length).toBeGreaterThan(50);
    const offenders = files.flatMap((f) =>
      agentLinkForks(readFileSync(f, "utf8"), isConsolePage(f)).map(
        (hit) => `${relative(APP_ROOT, f)}: ${hit}`
      )
    );
    expect(offenders).toEqual([]);
  });

  it("the console's agent links reach the door (it is not dead)", () => {
    // Derived, not listed: every source file that imports the door.
    const IMPORTS_DOOR =
      /import\s*\{[^}]*\bagentHref\b[^}]*\}\s*from\s*["'][^"']*lib\/console-nav["']/;
    const callers = sourceFiles()
      .filter((f) => IMPORTS_DOOR.test(readFileSync(f, "utf8")))
      .map((f) => relative(APP_ROOT, f));
    // Agents, Agents & work (list + page), a computer's agents, keys, and
    // `/open/agent` sending a pod admin to the page.
    expect(callers.length).toBeGreaterThanOrEqual(6);
    expect(callers).toContain(join("app", "open", "open-params.ts"));
  });
});
