/**
 * TRIPWIRE — every API-key revoke goes through the ONE door, `revokeApiKeys`
 * (`@synap/database/api-key-revocation`), which drops the verification cache
 * `/mcp` and the Hub validate from.
 *
 * WHY. The revoke UPDATE lived at a dozen call sites and most forgot the cache
 * (`connectIntegration` replace_existing, `adminRevokeAllForUser`, the
 * repository's revoke/rotate, the IS registry…): a revoked key kept validating
 * for up to 30s while the UI said "immediately".
 *
 * HOW (derived by walking `packages/api/src`, `apps/api/src`,
 * `packages/database/src`; tests skipped): every `.update(apiKeys)` whose
 * `.set({ … })` object writes `revokedAt` is an offender unless it is in the
 * door file itself. An approval flip (`isActive: true` with `revokedAt` only in
 * the WHERE) is not a revoke and is not flagged.
 *
 * WHAT IT DOES NOT SEE (measured, not implied): raw SQL (`UPDATE api_keys …`),
 * a table aliased under another name, or a `.set(values)` built in a variable.
 * `packages/realtime` is a separate process with no verification cache and is
 * not scanned.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const ROOTS = ["packages/api/src", "apps/api/src", "packages/database/src"].map(
  (r) => join(REPO, r)
);
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);
const DOOR = "packages/database/src/utils/api-key-revocation.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** The `.set({ … })` object that follows an `.update(apiKeys)` at `at`, or "". */
export function setObjectAfter(src: string, at: number): string {
  const m = /^\s*\.set\(\s*\{/.exec(src.slice(at));
  if (!m) return "";
  const start = at + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
}

const UPDATE = /\.update\(apiKeys\)/g;
const revokes: Array<{ file: string; line: number }> = [];
let updates = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(UPDATE)) {
      updates++;
      if (/\brevokedAt\s*:/.test(setObjectAfter(src, m.index! + m[0].length))) {
        revokes.push({
          file: relative(REPO, file),
          line: src.slice(0, m.index).split("\n").length,
        });
      }
    }
  }
}

describe("one API-key revoke door", () => {
  it("scans real code and its parser sees a revoke (non-vacuity)", () => {
    // Non-revoke updates (lastUsedAt stamps, approval flips) still exist.
    expect(updates).toBeGreaterThanOrEqual(5);
    const sample = "db\n  .update(apiKeys)\n  .set({\n    isActive: false,\n    revokedAt: new Date(),\n  })";
    const at = sample.indexOf(".update(apiKeys)") + ".update(apiKeys)".length;
    expect(setObjectAfter(sample, at)).toMatch(/revokedAt/);
    // The door itself is found — the scan reaches packages/database.
    expect(revokes.map((r) => r.file)).toContain(DOOR);
  });

  it("no revoke UPDATE outside the door", () => {
    expect(
      revokes.filter((r) => r.file !== DOOR).map((r) => `${r.file}:${r.line}`)
    ).toEqual([]);
  });
});
