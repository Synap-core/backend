/**
 * TRIPWIRE — a CLOSED vocabulary must never be mapped through `Record<string, …>`.
 *
 * THE BUG CLASS THIS GUARDS
 * -------------------------
 * Both template-provisioning doors carried this:
 *
 *     const scopeMap: Record<string, string> =
 *       { SYSTEM: "system", SHARED: "shared", WORKSPACE: "workspace", USER: "user" };
 *     const scope = profile.scope ? (scopeMap[profile.scope] ?? "workspace") : "workspace";
 *
 * Templates declare scope in MIXED case (55 × "WORKSPACE", 17 × "shared"), so
 * `scopeMap["shared"]` returned `undefined`, the `?? "workspace"` fallback ate
 * it, and all 17 pod-wide shared roles were silently demoted to private
 * per-workspace duplicates. It type-checked perfectly and shipped.
 *
 * `Record<string, …>` is the whole reason it was invisible: it accepts ANY key
 * and yields `… | undefined`, so the compiler has nothing to say — while the
 * map's own object literal proves the key space is a CLOSED SET of four tokens.
 * The type erased exactly the fact that made the map checkable. Correct shape:
 *
 *     const SCOPE_BY_TOKEN: Record<ProfileScope, ProfileScope> = { … };
 *
 * which is TOTAL over the vocabulary — a new member breaks the build.
 *
 * PRECISION TRADE-OFF (deliberate — read before widening)
 * ------------------------------------------------------
 * The obvious rule — "flag `Record<string, …>` on any identifier whose name
 * contains scope / kind / action" — was measured against this codebase and
 * produced 6 hits of which 4 are legitimate and must NOT be flagged: `BUILTIN_VERBS`
 * (open verb registry), `INTEGRATION_HUB_SCOPES` (open integration names),
 * `byKind` (an aggregation counter), `SCHEME_ALLOWED_KINDS` (URL schemes). A
 * guard that cries wolf on 4/6 gets suppressed, and then guards nothing — the
 * same fate as the tripwire this session had to un-skip.
 *
 * So the rule keys on EVIDENCE, not on names: it fires only when a
 * `Record<string, …>`-annotated object literal's OWN KEYS are a known closed
 * vocabulary (case-insensitively). That is the exact signature of the bug and
 * nothing else — the literal itself proves the key space is closed, so
 * `Record<string, …>` is provably the wrong type there. Name-shaped heuristics
 * are intentionally NOT used.
 *
 * KNOWN LIMIT (stated, not papered over): this catches vocabulary maps written
 * as an inline object literal — the form the bug took in both doors. It does
 * NOT catch a closed vocabulary assembled dynamically or split across files.
 * That is the narrow-but-useful trade: zero false positives on today's tree, in
 * exchange for not being a universal `Record` policy. Widen the vocabularies
 * below as new closed key spaces appear.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_PACKAGES = resolve(HERE, "../../..");

/** Roots scanned — the DTO/apply seams where template & AI input is mapped in. */
const SCAN_ROOTS = [
  join(REPO_PACKAGES, "database", "src"),
  join(REPO_PACKAGES, "api", "src"),
];

/**
 * Closed vocabularies. A map literal whose key set is a SUBSET of one of these
 * (and covers >= 2 of its members, so a one-off lookup table doesn't trip it)
 * is provably keyed by a finite domain and must be typed by that domain.
 */
const CLOSED_VOCABULARIES: Record<string, readonly string[]> = {
  // profiles.scope — ProfileScope enum (schema/profiles.ts)
  ProfileScope: ["system", "shared", "workspace", "user"],
  // profiles.profileKind — entity identity vs role
  ProfileKind: ["kind", "role"],
  // entities.entityScope — pod-wide vs workspace-filed
  EntityScope: ["pod", "workspace"],
};

const MIN_VOCABULARY_MEMBERS_TO_FLAG = 2;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".d.ts") &&
      // Tests are not DTO/apply seams, and they legitimately contain the
      // anti-pattern as a FIXTURE (this file's own regression proof does).
      !entry.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments so documentation OF the anti-pattern never trips the guard. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);
}

/** Read the balanced `{ … }` starting at `open`; returns its inner body. */
function readObjectBody(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** Top-level keys of an object-literal body (ignores nested objects). */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let atKeyPosition = true;
  let buffer = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (depth !== 0) continue;
    if (ch === ",") {
      atKeyPosition = true;
      buffer = "";
      continue;
    }
    if (ch === ":" && atKeyPosition) {
      const raw = buffer.trim().replace(/^["'`]|["'`]$/g, "");
      if (/^[A-Za-z_$][\w$]*$/.test(raw)) keys.push(raw);
      atKeyPosition = false;
      buffer = "";
      continue;
    }
    buffer += ch;
  }
  return keys;
}

interface Violation {
  file: string;
  line: number;
  identifier: string;
  vocabulary: string;
  keys: string[];
}

/** `const NAME: Record<string, …> = {` — the annotated-literal form. */
const RECORD_STRING_LITERAL =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*Record<\s*string\s*,[^=]*?=\s*\{/g;

function scan(file: string): Violation[] {
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);
  const violations: Violation[] = [];
  for (const m of src.matchAll(RECORD_STRING_LITERAL)) {
    const open = m.index! + m[0].length - 1;
    const body = readObjectBody(src, open);
    if (!body) continue;
    const keys = topLevelKeys(body);
    if (keys.length === 0) continue;
    const lowered = keys.map((k) => k.toLowerCase());
    for (const [vocab, members] of Object.entries(CLOSED_VOCABULARIES)) {
      const hits = lowered.filter((k) => members.includes(k));
      const isSubset = lowered.every((k) => members.includes(k));
      if (isSubset && hits.length >= MIN_VOCABULARY_MEMBERS_TO_FLAG) {
        violations.push({
          file: relative(REPO_PACKAGES, file),
          line: src.slice(0, m.index!).split("\n").length,
          identifier: m[1],
          vocabulary: vocab,
          keys,
        });
        break;
      }
    }
  }
  return violations;
}

describe("tripwire — closed vocabularies are never typed `Record<string, …>`", () => {
  it("no vocabulary map at a DTO/apply seam is keyed by bare `string`", () => {
    const files = SCAN_ROOTS.flatMap(walk);
    // Guard the guard: if the scan finds nothing, the roots are wrong and this
    // test would pass vacuously — exactly the failure mode of the skipIf'd
    // tripwire this replaces.
    expect(files.length).toBeGreaterThan(50);

    const violations = files.flatMap(scan);
    const report = violations
      .map(
        (v) =>
          `${v.file}:${v.line} — '${v.identifier}' is typed Record<string, …> but its keys ` +
          `{${v.keys.join(", ")}} are the CLOSED ${v.vocabulary} vocabulary. ` +
          `A bare-string key type silently returns undefined for an unmapped/mis-cased token ` +
          `(the exact bug that demoted 17 pod-wide 'shared' roles to workspace duplicates). ` +
          `Type it Record<${v.vocabulary}, …> so the compiler enforces totality, ` +
          `or route it through the shared normalizer ` +
          `(@synap/database → normalizeProfileScope).`
      )
      .join("\n");
    expect(violations, report).toEqual([]);
  });

  it("detects the historical scopeMap regression if it is reintroduced", () => {
    // Behavioral proof the rule actually fires — a guard nobody has seen fail is
    // a guard nobody knows works.
    const regression = `
      const scopeMap: Record<string, string> = {
        SYSTEM: "system", SHARED: "shared", WORKSPACE: "workspace", USER: "user",
      };
    `;
    const body = readObjectBody(regression, regression.indexOf("{"));
    const keys = topLevelKeys(body!).map((k) => k.toLowerCase());
    expect(keys).toEqual(["system", "shared", "workspace", "user"]);
    expect(
      keys.every((k) => CLOSED_VOCABULARIES.ProfileScope.includes(k))
    ).toBe(true);
  });

  it("does NOT flag legitimate open-vocabulary maps", () => {
    // The 4 real maps a name-based rule would have false-positived on.
    for (const open of [
      `const BUILTIN_VERBS: Record<string, Handler> = { "entity.create": h, "entity.read": h };`,
      `const INTEGRATION_HUB_SCOPES: Record<string, string[]> = { google: [], slack: [] };`,
      `const byKind: Record<string, number> = {};`,
      `const SCHEME_ALLOWED_KINDS: Record<string, readonly string[]> = { https: [], mailto: [] };`,
    ]) {
      const body = readObjectBody(open, open.indexOf("{"));
      const keys = topLevelKeys(body ?? "").map((k) => k.toLowerCase());
      const trips = Object.values(CLOSED_VOCABULARIES).some(
        (members) =>
          keys.length > 0 &&
          keys.every((k) => members.includes(k)) &&
          keys.filter((k) => members.includes(k)).length >=
            MIN_VOCABULARY_MEMBERS_TO_FLAG
      );
      expect(trips, `false positive on: ${open}`).toBe(false);
    }
  });
});
