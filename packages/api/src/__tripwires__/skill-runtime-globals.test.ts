import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  scanSkillGlobals,
  SKILL_RUNTIME_ALLOWED_GLOBALS,
} from "../routers/skills.js";

/**
 * TRIPWIRE — the code-skill save-time global-reference scan (B1) protects the
 * right surface, and its allow-list stays in sync with the Intelligence Service
 * runtime SSOT.
 *
 * A code skill runs in an isolated-vm isolate whose only globals are pure
 * ECMAScript built-ins + the versioned skill stdlib (host bridges + web
 * polyfills). `scanSkillGlobals` rejects a skill that references anything else
 * BEFORE it persists, so an author/AI learns the gap at create time rather than
 * the run failing with a ReferenceError (the `URLSearchParams` bug class).
 *
 * INVARIANTS:
 *   1. The allow-list contains every web global + host bridge the runtime
 *      provides and NONE of the deliberately-omitted globals (fetch/crypto/…).
 *   2. The scan flags an unprovided global and passes clean, runtime-only code.
 *   3. When the IS sibling repo is checked out, the backend allow-list is byte-
 *      equivalent to the IS runtime SSOT (skill-stdlib.ts) — no cross-repo drift.
 */

const IS_STDLIB_PATH = join(
  __dirname,
  "../../../../../synap-intelligence-service/apps/intelligence-hub/src/executors/skill-stdlib.ts"
);

/** Extract a string-array literal `export const NAME = [ ... ]` from source. */
function extractArray(src: string, name: string): string[] {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${name} in skill-stdlib.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("skill runtime global scan — tripwire", () => {
  it("(1) allow-list covers the provided surface and omits forbidden globals", () => {
    for (const provided of [
      // web polyfills
      "URL",
      "URLSearchParams",
      "TextEncoder",
      "TextDecoder",
      "btoa",
      "atob",
      "structuredClone",
      // host bridges
      "console",
      "hubProtocol",
      "secrets",
      "host",
      "callProvider",
      "propose",
      // wrapper params + representative natives
      "args",
      "context",
      "JSON",
      "Promise",
      "Object",
      "Uint8Array",
    ]) {
      expect(
        SKILL_RUNTIME_ALLOWED_GLOBALS.has(provided),
        `allow-list is missing "${provided}"`
      ).toBe(true);
    }
    for (const forbidden of [
      "fetch",
      "crypto",
      "process",
      "require",
      "setTimeout",
      "setInterval",
      "Buffer",
      "__dirname",
      "module",
    ]) {
      expect(
        SKILL_RUNTIME_ALLOWED_GLOBALS.has(forbidden),
        `"${forbidden}" must NOT be allow-listed`
      ).toBe(false);
    }
  });

  it("(2) flags unprovided globals and passes runtime-only code", () => {
    const bad = scanSkillGlobals(`
      const res = await fetch('https://x');       // not provided
      const id = crypto.randomUUID();             // not provided
      return { res, id };
    `);
    expect(bad.ok).toBe(false);
    expect(bad.unknownGlobals).toEqual(["crypto", "fetch"]);

    const good = scanSkillGlobals(`
      const found = await hubProtocol.search(args.query, { limit: 10 });
      const params = new URLSearchParams({ q: args.query });
      const r = await host.fetch('https://x?' + params.toString());
      const enc = new TextEncoder().encode(JSON.stringify(found));
      function helper(x) { return x + local; }
      const local = 1;
      return { found, r, n: enc.length, h: helper(2), b: btoa('x') };
    `);
    expect(good.ok, JSON.stringify(good.unknownGlobals)).toBe(true);

    // local shadow of an allowed name is never flagged; a syntax error is caught
    expect(scanSkillGlobals(`const URL = 1; return URL;`).ok).toBe(true);
    expect(scanSkillGlobals(`const x = (`).parseError).toBeTruthy();
  });

  it("(3) allow-list matches the IS runtime SSOT (when sibling checked out)", () => {
    if (!existsSync(IS_STDLIB_PATH)) {
      // IS repo not present in this checkout. In a plain backend-only
      // checkout that's expected — invariants (1)+(2) still hold, so skip
      // gracefully. But a CI signal opting into the cross-repo check means
      // the sibling was SUPPOSED to be present (both repos checked out) —
      // silently skipping there would defeat the whole point of this
      // tripwire (drift never gets caught). Fail loudly instead.
      if (process.env.SYNAP_CHECK_CROSS_REPO_SSOT) {
        throw new Error(
          `SYNAP_CHECK_CROSS_REPO_SSOT is set but the intelligence-service sibling ` +
            `was not found at ${IS_STDLIB_PATH}. This check REQUIRES both ` +
            `synap-backend and synap-intelligence-service checked out side by side ` +
            `(as siblings) — check out both repos, or unset ` +
            `SYNAP_CHECK_CROSS_REPO_SSOT to skip this check locally.`
        );
      }
      return;
    }
    const src = readFileSync(IS_STDLIB_PATH, "utf8");
    const isUnion = new Set<string>([
      ...extractArray(src, "SKILL_ECMASCRIPT_GLOBALS"),
      ...extractArray(src, "SKILL_WEB_GLOBALS"),
      ...extractArray(src, "SKILL_HOST_BRIDGES"),
      ...extractArray(src, "SKILL_WRAPPER_PARAMS"),
    ]);
    expect(
      new Set(SKILL_RUNTIME_ALLOWED_GLOBALS),
      "backend save-time-scan allow-list has drifted from the IS runtime SSOT (skill-stdlib.ts)"
    ).toEqual(isUnion);
  });
});
