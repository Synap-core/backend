/**
 * Tripwire — every grant WRITE re-clips hosted agents (MACHINE-IDENTITY-PLAN
 * §2c: "an agent never exceeds its computer" is a write-time invariant, so it
 * holds only if every door that writes a grant calls `clipHostedAgentGrants`).
 *
 * The scanned set is DERIVED: every non-test source file under api/src,
 * database/src and jobs/src is searched for the GrantRepository write verbs
 * (`attachMany(`, `new GrantRepository(…).attach(`, `carryOver(`,
 * `movePrincipal(`). A new write site joins the scan by existing.
 *
 * For each site, the text from the write to the end of its enclosing block
 * (a top-level function's closing `\n}` or a router procedure's `\n    }),`)
 * must call `clipHostedAgentGrants(`. Exempt, with the reason, and asserted to
 * still exist so an exemption cannot outlive its site:
 *   - the write INSIDE `clipHostedAgentGrants` (the clip's own write);
 *   - `GrantRepository` itself (the verbs' definitions);
 *   - `carryOver` (rotation): copies the SAME scopes to the replacing key — a
 *     clipped key's successor is as clipped, a computer's successor lends the
 *     same reach;
 *   - `movePrincipal` (app keys adopted by the app's agent): moves the holder,
 *     never the permissions, and an app agent is never hosted.
 *
 * DOES NOT SEE: a grant written by raw SQL / `db.insert(grants)` outside
 * GrantRepository (that would already break the "one write door" rule of
 * grant-repository.ts), and a clip call placed in the block but on a branch
 * that skips it. Granularity is the enclosing block, not the statement.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "../../..");
const ROOTS = ["api/src", "database/src", "jobs/src"].map((r) =>
  join(PACKAGES, r)
);

const WRITE =
  /\.attachMany\(|new GrantRepository\([^)]*\)\s*\.attach\(|\.carryOver\(|\.movePrincipal\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      p.endsWith(".ts") &&
      !p.endsWith(".test.ts") &&
      !p.includes("__tests__")
    )
      out.push(p);
  }
  return out;
}

interface Site {
  file: string;
  verb: string;
  block: string;
  enclosingFn: string | null;
}

function sites(): Site[] {
  const out: Site[] = [];
  for (const file of ROOTS.flatMap((r) => walk(r))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(WRITE)) {
      const at = m.index!;
      const ends = [src.indexOf("\n}", at), src.indexOf("\n    }),", at)]
        .filter((i) => i !== -1);
      const end = ends.length ? Math.min(...ends) : src.length;
      const before = src.slice(0, at);
      const fns = [...before.matchAll(/(?:async )?function (\w+)\(/g)];
      out.push({
        file: relative(PACKAGES, file),
        verb: m[0],
        block: src.slice(at, end),
        enclosingFn: fns.length ? fns[fns.length - 1]![1]! : null,
      });
    }
  }
  return out;
}

const DEFINITION_FILE = "database/src/repositories/grant-repository.ts";
const exemptReason = (s: Site): string | null => {
  if (s.file === DEFINITION_FILE) return "the verbs' own definitions";
  if (s.enclosingFn === "clipHostedAgentGrants") return "the clip's own write";
  if (s.verb === ".carryOver(") return "rotation copies the same scopes";
  if (s.verb === ".movePrincipal(") return "app keys: holder moves, permissions do not";
  return null;
};

describe("every grant write re-clips hosted agents", () => {
  const all = sites();

  it("self-check: the pattern still sees a literal write", () => {
    expect("await new GrantRepository(db).attachMany(".match(WRITE)).not.toBeNull();
    expect("await new GrantRepository(tx).carryOver({".match(WRITE)).not.toBeNull();
  });

  it("non-vacuous: the scan finds the known write doors", () => {
    expect(all.length).toBeGreaterThanOrEqual(8);
    const files = new Set(all.map((s) => s.file));
    for (const f of [
      "api/src/routers/api-keys.ts",
      "api/src/services/key-grant.ts",
      "api/src/services/agent-connect.ts",
    ])
      expect(files).toContain(f);
  });

  it("each non-exempt site calls clipHostedAgentGrants after writing", () => {
    const missing = all
      .filter((s) => !exemptReason(s))
      .filter((s) => !s.block.includes("clipHostedAgentGrants("))
      .map((s) => `${s.file} ${s.verb} (in ${s.enclosingFn ?? "?"})`);
    expect(missing).toEqual([]);
  });

  it("at least one site is actually checked (not all exempt)", () => {
    expect(all.filter((s) => !exemptReason(s)).length).toBeGreaterThanOrEqual(3);
  });
});
