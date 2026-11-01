/**
 * GUARD — the leaves relay loads reach no bare module at runtime.
 *
 * Relay (Hermes) imports `@synap-core/types/connections`, `/vocabulary` and
 * `/presentation` through `@synap-core/hooks/profile-renderer/object`, and
 * app-bases checks their BUILT graphs (`object-subpath.dom-free.test.ts`,
 * "the connections leaf's BUILT graph reaches no bare module"). That check
 * reads backend's dist, so a backend change that pulls in `zod` turns
 * app-bases main red AFTER it lands here, with nothing red on the PR: on
 * 2026-11-01 `needs-you/rule.ts` reached `zod` through `ask/card.ts` →
 * `ask/index.ts` (the link dated from c11cf22a6, 27 Oct). This is the same
 * walk, run on the source, so the red lands on the backend PR that causes it.
 *
 * The walk follows VALUE imports and re-exports (`import type`, and a braced
 * list whose every specifier is `type`, are erased by tsc: this package does
 * not set `verbatimModuleSyntax`). A bare module is any specifier that is not
 * relative. An import written without `type` that names only types counts as
 * a value import here though tsc drops it: the guard errs strict.
 *
 * NOT covered: dynamic `import()`, and the list of leaves itself, which is
 * relay's (app-bases `ALLOWED_BARE`) and is mirrored by hand below.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "../../../scripts/strip-comments.mjs";

const SRC = import.meta.dirname;

/** The leaves relay loads (app-bases `object-subpath.dom-free.test.ts`). */
const RELAY_LEAVES = ["connections", "vocabulary", "presentation"] as const;

function valueImports(src: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|\n)\s*(?:import|export)\s+([^;"'`]*?)\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const clause = m[1]!.trim();
    if (/^type\b/.test(clause)) continue;
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      const specs = braced[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (specs.length > 0 && specs.every((s) => /^type\s/.test(s))) continue;
    }
    out.push(m[2]!);
  }
  const side = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = side.exec(src))) out.push(m[1]!);
  return out;
}

/** `./x.js` in source is `./x.ts` (Node16 resolution), or `./x/index.ts`. */
function resolveLocal(spec: string, from: string): string | null {
  const base = resolve(dirname(from), spec).replace(/\.js$/, "");
  for (const c of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Each bare module reached, with the import chain that reaches it. */
function walk(entry: string) {
  const seen = new Set<string>();
  const via = new Map<string, string>();
  const bare: string[] = [];
  const unresolved: string[] = [];
  const stack = [entry];
  const chain = (file: string) => {
    const out: string[] = [];
    for (let f: string | undefined = file; f; f = via.get(f)) {
      out.unshift(relative(SRC, f));
    }
    return out.join(" → ");
  };
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = stripComments(readFileSync(file, "utf8"), "ts");
    for (const spec of valueImports(src)) {
      if (!spec.startsWith(".")) {
        bare.push(`${chain(file)} → ${spec}`);
        continue;
      }
      const local = resolveLocal(spec, file);
      if (!local) {
        unresolved.push(`${relative(SRC, file)} → ${spec}`);
        continue;
      }
      if (!seen.has(local) && !via.has(local)) via.set(local, file);
      stack.push(local);
    }
  }
  const names = new Set([...seen].map((f) => relative(SRC, f)));
  return { names, bare, unresolved };
}

describe("the leaves relay loads reach no bare module (source walk)", () => {
  it.each(RELAY_LEAVES)("%s/index.ts reaches no bare module", (leaf) => {
    const { names, bare, unresolved } = walk(join(SRC, leaf, "index.ts"));
    expect(names.size).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
    expect(bare).toEqual([]);
  });

  it("NON-VACUITY: the connections walk reaches the needs-you rule and its ask leaf", () => {
    const { names } = walk(join(SRC, "connections", "index.ts"));
    // The chain that went red on 2026-11-01 is still inside the walk.
    expect([...names]).toEqual(
      expect.arrayContaining([
        "connections/neighbour-state.ts",
        "units/session.ts",
        "needs-you/rule.ts",
        "ask/ends-with-session.ts",
      ])
    );
    expect(names.size).toBeGreaterThan(30);
  });

  it("POSITIVE CONTROL: started at ask/index.ts, the walk sees zod", () => {
    const { bare } = walk(join(SRC, "ask", "index.ts"));
    expect(bare.some((b) => b.endsWith("ask/index.ts → zod"))).toBe(true);
  });

  it("POSITIVE CONTROL: value imports are read, type-only imports are not", () => {
    expect(
      valueImports(
        'import { z } from "zod";\nimport type { A } from "./a.js";\nimport { type B, type C } from "./b.js";\nexport { d } from "./d.js";\nimport { e, type F } from "./e.js";'
      )
    ).toEqual(["zod", "./d.js", "./e.js"]);
  });
});
