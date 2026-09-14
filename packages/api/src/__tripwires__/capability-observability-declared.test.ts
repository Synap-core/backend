import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * TRIPWIRE — every IN-PROCESS caller of `executeCapability` declares its
 * `observability` ("full" | "mirror") explicitly.
 *
 * THE DEFECT: `observability` defaults to "full", which deposits a
 * "Ran capability <verb> → {result…}" knowledge fact with an embedding call and
 * no dedup. For a cron or bulk read (connection sync, mail feed, Fireflies
 * backfill) that is one fact per page per tick of third-party payload — recall
 * noise, embedding spend, and data leaking into recall. The default is right
 * for a user's run and silently wrong for a machine read, so a server-side
 * caller must CHOOSE rather than inherit.
 *
 * THE SCANNED SET IS DERIVED: every non-test `.ts` under `src/` that calls
 * `executeCapability(`, except
 *   - `routers/` — the client doors; they are user runs and must NOT set the
 *     flag at all (it is in `SERVER_DERIVED_PARAMS`; T5 audits them);
 *   - the service module itself.
 * A new bulk caller joins the scan by existing.
 *
 * WHAT IT CANNOT SEE: it proves a top-level `observability` KEY is present at
 * each call site, not that the chosen value is right — "full" on a cron read
 * passes. It also misses a call whose argument is not an inline object literal
 * (a spread-only or variable argument reads as "no key" and FAILS, which is the
 * safe direction), and a call through an alias (`const run = executeCapability`).
 */

const API_SRC = join(__dirname, "..");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "__tripwires__",
  "__tests__",
  "routers",
]);
const SERVICE = join(API_SRC, "services/capabilities/execute-capability.ts");

/**
 * Callers that must declare and do not YET, because another session holds the
 * file. Self-cleaning: an entry whose file now declares (or no longer calls)
 * FAILS, so it cannot outlive its reason.
 */
const PENDING: Record<string, string> = {
  "services/capabilities/builtin-verbs.ts":
    "held by concurrent lanes (rc1, MCP xp lane G) on 2026-09-14; classify when released",
};

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...collect(full));
      continue;
    }
    if (
      !name.endsWith(".ts") ||
      name.endsWith(".d.ts") ||
      name.includes(".test.")
    )
      continue;
    if (full === SERVICE) continue;
    out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Top-level keys of the object literal opening at `open`, string- and depth-aware. */
function topLevelKeys(source: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let prev = "";
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i += 1; i < source.length && source[i] !== ch; i += 1) {
        if (source[i] === "\\") i += 1;
      }
      prev = '"';
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth += 1;
      prev = ch;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0) break;
      prev = ch;
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (depth === 1 && /[A-Za-z_$]/.test(ch) && /[{,]/.test(prev)) {
      const name = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))![0];
      const after = source.slice(i + name.length);
      // `key:` and shorthand `key,` / `key }` both declare the key.
      if (/^\s*[:,}]/.test(after)) keys.push(name);
      i += name.length - 1;
      prev = "x";
      continue;
    }
    prev = ch;
  }
  return keys;
}

/** Each `executeCapability({ … })` call site: does its argument declare `observability`? */
function callSites(source: string): { declares: boolean }[] {
  const code = stripComments(source);
  const out: { declares: boolean }[] = [];
  const re = /\bexecuteCapability\s*\(\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const at = m.index + m[0].length;
    if (code[at] !== "{") {
      out.push({ declares: false });
      continue;
    }
    out.push({ declares: topLevelKeys(code, at).includes("observability") });
  }
  return out;
}

describe("tripwire: in-process executeCapability callers declare observability", () => {
  const files = collect(API_SRC)
    .map((full) => ({
      rel: relative(API_SRC, full),
      sites: callSites(readFileSync(full, "utf8")),
    }))
    .filter((f) => f.sites.length > 0);

  it("the scanner can still see what it hunts (self-check)", () => {
    expect(
      callSites(
        `await executeCapability({ verbId: "x", observability: "mirror" });`
      )
    ).toEqual([{ declares: true }]);
    expect(
      callSites(
        `await executeCapability({ verbId: "x", parameters: { observability: 1 } });`
      )
    ).toEqual([{ declares: false }]);
    expect(callSites(`await executeCapability(args);`)).toEqual([
      { declares: false },
    ]);
  });

  it("finds a plausible set of callers (non-vacuity)", () => {
    // 2026-09-14: sync-kind-registry, migrate-gcal-events, fireflies ingest +
    // backfill, mail-feed, enrich-shared, builtin-verbs, calcom backfill.
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.map((f) => f.rel)).toContain(
      "services/event-sync/sync-kind-registry.ts"
    );
  });

  it("every call site declares observability (or is a pending, held file)", () => {
    const missing = files
      .filter((f) => f.sites.some((s) => !s.declares))
      .map((f) => f.rel)
      .filter((rel) => !(rel in PENDING));
    expect(missing).toEqual([]);
  });

  it("pending entries are still true (self-cleaning)", () => {
    const stale = Object.keys(PENDING).filter((rel) => {
      const f = files.find((x) => x.rel === rel);
      return !f || f.sites.every((s) => s.declares);
    });
    expect(stale).toEqual([]);
  });
});
