/**
 * TRIPWIRE — every relation type an MCP tool schema NAMES must actually resolve.
 *
 * Prose in a tool schema is EXECUTABLE: the model reads it and complies. On
 * 2026-09-07 a founder called `synap_capture` with `type: "part_of"` and
 * `synap_link_entities` with its own `default: "relates_to"`, because the
 * schemas said the type was a "free string" and offered those examples. Both
 * were rejected by `relations.create` — `related_to`, `contact_for`, `child_of`,
 * `belongs_to` and `authored_by` are not relation defs ANYWHERE in the product,
 * and never were. The capture's edges landed in `relationsFailed[]` while the
 * receipt still said `applied`.
 *
 * This is the same class as the `@param` doc that instructed callers to build an
 * owner-blind query, and a caller did exactly that. A description is a contract
 * with the model; an untrue one is a defect with a compliant victim.
 *
 * WHAT IS ASSERTED: every relation-type token a tool schema names — in a
 * description, in a JSON example inside a description, or as a `default` — is a
 * member of the resolvable set (`DEFAULT_RELATION_DEFS` ∪ `SYSTEM_RELATION_TYPES`
 * ∪ `IMPACT_RELATION_TYPES` ∪ `EXPOSURE_RELATION_TYPES`).
 *
 * WHAT IS READ: `mcp-tools.manifest.json` — the SHIPPED artifact, not the source
 * that generates it. A regex over `tools/index.ts` would read a constant's NAME
 * where the manifest holds its VALUE, and would go green against source that no
 * longer matches what agents actually receive. `manifest-freshness.test.ts`
 * already fails when the manifest drifts from `tools/index.ts`, so the pair
 * covers both halves.
 *
 * NON-VACUITY: a scanner that finds nothing reads green forever. Every harvest
 * below is floored — the known set, the number of sites, the number of tokens,
 * and the two tools that MUST be scanned are each asserted explicitly, so
 * renaming a field or rewording a description can never silently empty this.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RELATION_DEFS, SYSTEM_RELATION_TYPES } from "@synap/database";
import { IMPACT_RELATION_TYPES } from "../routers/relations.js";
import { EXPOSURE_RELATION_TYPES } from "../utils/project-scope.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(
  __dirname,
  "../routers/mcp/tools/mcp-tools.manifest.json"
);

/** Every relation type `relations.create` will accept for SOME caller. */
const RESOLVABLE: ReadonlySet<string> = new Set<string>([
  ...DEFAULT_RELATION_DEFS.map((d) => d.slug),
  ...SYSTEM_RELATION_TYPES,
  ...IMPACT_RELATION_TYPES,
  ...EXPOSURE_RELATION_TYPES,
]);

/**
 * A schema node is a RELATION-TYPE SITE when its own description talks about
 * relations at all. Deliberately broad on the site test and narrow on the
 * harvest: a false site contributes zero tokens, but a missed site is a blind
 * spot — which is the failure mode this file exists to prevent.
 *
 * This filter alone is NOT sufficient, and the ANCHOR RULE below covers its gap:
 * a new list of relation types written without ever using the word "relation"
 * would sail past it. That gap is not hypothetical — the defect this file exists
 * for was a SECOND COPY of an already-fixed list three hundred lines above the
 * fix, which is precisely the shape a narrow filter misses.
 */
const MENTIONS_RELATIONS = /relation/i;

/**
 * `'relates_to', 'references', 'mentions'` — a comma-separated RUN of quoted
 * tokens. Every real relation-type listing in these schemas has this shape, and
 * so did the defective one ("'related_to', 'parent_of', 'child_of', …").
 *
 * A run of two or more is required on purpose. Descriptions that merely MENTION
 * relations also quote single non-relation words in prose — `May return
 * 'proposed'`, an `'unknown'` outcome, an enum member like `'auto'` — and
 * harvesting those would make this file cry wolf until someone deleted it. A
 * brittle guard is a deleted guard.
 *
 * STATED LIMIT: a lone relation type quoted in running prose ("use 'part_of'")
 * is NOT harvested. The two spots where a model complies WITHOUT reading prose —
 * a `default` and a JSON example — are harvested unconditionally below, and
 * those are the ones that produced the reported defect.
 */
const QUOTED_RUN = /'[a-z][a-z0-9_]*'(?:\s*,\s*'[a-z][a-z0-9_]*')+/g;
const QUOTED_TOKEN = /'([a-z][a-z0-9_]*)'/g;
/** `"type": "works_at"` — a relation type inside a JSON example. */
const JSON_TYPE_FIELD = /"type"\s*:\s*"([a-z][a-z0-9_]*)"/g;

interface Site {
  /** Dotted path into the manifest, for a failure message that names the file. */
  path: string;
  tokens: string[];
}

/** The tokens of one quoted run, in order. */
function runTokens(run: string): string[] {
  return [...run.matchAll(QUOTED_TOKEN)].map((m) => m[1]);
}

/**
 * THE ANCHOR RULE — scans EVERY description in the manifest, not only the ones
 * that happen to say "relation".
 *
 * A quoted run is a relation-type listing if ANY of its tokens is a real
 * relation slug. That one real member anchors the whole run, so a list like
 * `'relates_to', 'part_of'` is caught wherever it is written, while the file's
 * many other quoted vocabularies — facet slugs `'client', 'investor'`, proposal
 * statuses `'approved', 'rejected'`, profile slugs `'post', 'deal', 'lead'` —
 * carry no relation slug and are ignored.
 *
 * MEASURED, not assumed: across all 348 description strings in the manifest,
 * this rule anchors 3 runs and produces ZERO false positives. It is also
 * self-maintaining — no per-path allowlist to drift, and nothing keyed on tool
 * INDEX (which renumbers the moment a tool is added).
 *
 * Residual limit, stated: a run of types that are ALL bogus, in a description
 * that never says "relation", has no anchor and would be missed. The two spots
 * where a model complies without reading prose — `default` and a JSON example —
 * remain scanned unconditionally, and those produced the reported defect.
 */
function anchoredRunTokens(description: string, known: ReadonlySet<string>) {
  const tokens = new Set<string>();
  for (const run of description.match(QUOTED_RUN) ?? []) {
    const toks = runTokens(run);
    if (toks.some((t) => known.has(t))) for (const t of toks) tokens.add(t);
  }
  return tokens;
}

function harvest(
  description: string,
  defaultValue: unknown,
  enumValues: unknown
): string[] {
  const tokens = new Set<string>();
  for (const run of description.match(QUOTED_RUN) ?? []) {
    for (const m of run.matchAll(QUOTED_TOKEN)) tokens.add(m[1]);
  }
  for (const m of description.matchAll(JSON_TYPE_FIELD)) tokens.add(m[1]);
  if (typeof defaultValue === "string" && defaultValue)
    tokens.add(defaultValue);
  // A node with its OWN `enum` is a closed vocabulary of something else (e.g.
  // `workspaceRouting: auto | ask | locked`) — its members are never relation
  // types, and the schema already constrains them.
  if (Array.isArray(enumValues)) {
    for (const value of enumValues) tokens.delete(value as string);
  }
  return [...tokens];
}

/**
 * Walk EVERY node of the manifest. Two independent ways to become a site, so
 * neither rule's blind spot is the file's blind spot:
 *   1. the description mentions relations   → full harvest (runs + JSON example
 *                                              + `default`, minus own `enum`)
 *   2. the ANCHOR RULE fires anywhere       → that run's tokens, from any
 *                                              description in the file
 */
function collectSites(
  node: unknown,
  path: string,
  out: Site[],
  known: ReadonlySet<string>
): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) =>
      collectSites(child, `${path}[${i}]`, out, known)
    );
    return;
  }
  if (!node || typeof node !== "object") return;
  const row = node as Record<string, unknown>;
  const description = row.description;
  if (typeof description === "string") {
    const tokens = new Set(anchoredRunTokens(description, known));
    if (MENTIONS_RELATIONS.test(description)) {
      for (const t of harvest(description, row.default, row.enum))
        tokens.add(t);
    }
    if (tokens.size) out.push({ path, tokens: [...tokens] });
  }
  for (const [key, child] of Object.entries(row)) {
    if (key === "description") continue;
    collectSites(child, `${path}.${key}`, out, known);
  }
}

describe("TRIPWIRE: relation types named in MCP tool schemas must resolve", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  };

  const sites: Site[] = [];
  collectSites(manifest.tools, "tools", sites, RESOLVABLE);

  // ── NON-VACUITY FLOORS ───────────────────────────────────────────────────
  // Each of these fails LOUDLY rather than letting the scan read green on an
  // empty harvest. A rename that empties the walk trips here, not in silence.

  it("has a non-empty resolvable set to check against", () => {
    expect(RESOLVABLE.size).toBeGreaterThanOrEqual(20);
    expect(RESOLVABLE.has("relates_to")).toBe(true);
    // The exact tokens the reported defect used, pinned as the ground truth
    // this file was written against: one real, one never real.
    expect(RESOLVABLE.has("part_of")).toBe(false);
    expect(RESOLVABLE.has("related_to")).toBe(false);
  });

  it("found relation-type sites to scan (never vacuously green)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(2);
    const tokenCount = new Set(sites.flatMap((s) => s.tokens)).size;
    expect(tokenCount).toBeGreaterThanOrEqual(6);
  });

  it("scans BOTH doors that write relations", () => {
    // The two tools a model uses to create an edge. If either stops being
    // scanned — renamed, reworded, restructured — that is a hole, not a pass.
    const scanned = (name: string) => {
      const idx = manifest.tools.findIndex((t) => t.name === name);
      expect(idx, `${name} missing from the manifest`).toBeGreaterThanOrEqual(
        0
      );
      return sites.some((s) => s.path.startsWith(`tools[${idx}]`));
    };
    expect(scanned("synap_link_entities")).toBe(true);
    expect(scanned("synap_capture")).toBe(true);
  });

  it("names only relation types that actually resolve", () => {
    const offenders = sites.flatMap((site) =>
      site.tokens
        .filter((token) => !RESOLVABLE.has(token))
        .map((token) => `${site.path}: '${token}'`)
    );
    expect(
      offenders,
      `A tool schema names relation types that no relation_def provides, so a ` +
        `model following the schema gets its edges rejected. Either use a slug ` +
        `from DEFAULT_RELATION_DEFS (database/src/utils/default-relation-defs.ts) ` +
        `or seed the def — never advertise a type the executor refuses.`
    ).toEqual([]);
  });

  it("every string `default` on a relation-type site resolves", () => {
    // Called out separately from the description scan because a default is
    // WORSE than an example: the model does not have to read it to comply. The
    // reported call was made with `synap_link_entities`' own default.
    const idx = manifest.tools.findIndex(
      (t) => t.name === "synap_link_entities"
    );
    const schema = manifest.tools[idx].inputSchema as {
      properties?: { type?: { default?: unknown } };
    };
    const fallback = schema?.properties?.type?.default;
    expect(
      typeof fallback,
      "synap_link_entities lost its `type` default — this assertion is now vacuous"
    ).toBe("string");
    expect(RESOLVABLE.has(fallback as string)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SKILL FILES — the same contract, on the surface agents load most.
//
// The header's premise ("prose is EXECUTABLE: the model reads it and complies")
// is at least as true of a skill topic as of a tool schema: `skills/manifest.json`
// `baseline` packages are delivered to EVERY agent context (`GET /skills/system`,
// seeded as `system/<pkg>/<stem>` rows by `ensureSystemSkills`, installed on disk
// by the CLI). On 2026-09-12 this scan's first run found 12 unresolvable slugs
// taught there — `related_to` in a worked example, `source` in the research flow,
// and a "pick a type" table with 7 bogus rows — while the manifest scan above was
// green, because it never looked.
//
// WHAT IS READ: every `*.md` under `synap-backend/skills/`, DERIVED by walking the
// tree (a new package or topic joins by existing). The generated `SKILL.md` is
// included on purpose: it is the `?scope=core` payload agents actually receive,
// so a hand-edit there is caught too. README.md is excluded (packaging copy, the
// same exclusion the disk loader applies).
//
// HARVEST — markdown carries ~60 `"type": "..."` fields that are NOT relations
// (bento, output, condition, note…), so an unanchored scan cries wolf. A token is
// harvested only under one of three anchors:
//   A. a `type` value within ±6 lines of a relation ENDPOINT key
//      (sourceEntityId / targetEntityId / sourceRef / targetRef)
//   B. a `type=` / `type:` on a line naming the `/relations` route
//   C. a contiguous markdown TABLE whose backticked first-cell tokens include at
//      least one real slug (the anchor rule above, adapted to tables)
//
// STATED LIMITS, measured on the first run (89 files, 39 sites, 19 tokens, zero
// false positives): a lone slug in running prose ("use `part_of`") with no
// endpoint, route or table nearby is NOT harvested. The IS mirror
// (`intelligence-hub/src/skills/baseline/`) is not read here — it is held
// byte-identical to these topic files by that repo's `baseline-drift.test.ts`.
// IS-ONLY skills (e.g. `propose-workspace.md`, which teaches `owned_by`) are NOT
// covered by either guard.
// ═══════════════════════════════════════════════════════════════════════════

const SKILLS_ROOT = join(__dirname, "../../../../skills");

function listSkillMarkdown(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSkillMarkdown(full);
    return entry.name.endsWith(".md") && entry.name !== "README.md"
      ? [full]
      : [];
  });
}

const ENDPOINT_KEY =
  /\b(?:sourceEntityId|targetEntityId|sourceRef|targetRef)\b/;
const RELATIONS_ROUTE = /\/relations\b/;
const MD_TYPE_VALUE = /\btype"?\s*[:=]\s*"?([a-z][a-z0-9_]*)"?/g;
const BACKTICK_TOKEN = /`([a-z][a-z0-9_]*)`/g;
const ENDPOINT_WINDOW = 6;

interface SkillSite {
  /** `pkg/file.md:line` — relative to skills/, stable across machines. */
  at: string;
  file: string;
  token: string;
}

function harvestSkillFile(absPath: string, known: ReadonlySet<string>) {
  const file = relative(SKILLS_ROOT, absPath);
  const lines = readFileSync(absPath, "utf8").split("\n");
  const out = new Map<string, SkillSite>();
  const add = (lineIdx: number, token: string) => {
    const at = `${file}:${lineIdx + 1}`;
    out.set(`${at}:${token}`, { at, file, token });
  };

  lines.forEach((line, i) => {
    if (ENDPOINT_KEY.test(line)) {
      const lo = Math.max(0, i - ENDPOINT_WINDOW);
      const hi = Math.min(lines.length - 1, i + ENDPOINT_WINDOW);
      for (let j = lo; j <= hi; j++) {
        for (const m of lines[j].matchAll(MD_TYPE_VALUE)) add(j, m[1]);
      }
    }
    if (RELATIONS_ROUTE.test(line)) {
      for (const m of line.matchAll(MD_TYPE_VALUE)) add(i, m[1]);
    }
  });

  for (let i = 0; i < lines.length;) {
    if (!lines[i].trimStart().startsWith("|")) {
      i++;
      continue;
    }
    const block: Array<[number, string]> = [];
    let j = i;
    while (j < lines.length && lines[j].trimStart().startsWith("|")) {
      const firstCell = lines[j].split("|")[1] ?? "";
      for (const m of firstCell.matchAll(BACKTICK_TOKEN)) block.push([j, m[1]]);
      j++;
    }
    if (block.some(([, t]) => known.has(t))) {
      for (const [lineIdx, t] of block) add(lineIdx, t);
    }
    i = j;
  }
  return [...out.values()];
}

/**
 * EXACT RATCHET — unresolvable slugs still taught, each awaiting a PRODUCT
 * decision (seed the def, or rewrite the teaching). Keyed `file:token` so a NEW
 * file teaching an already-pending slug is still caught. Both directions are
 * asserted: a new offender fails, and an entry that stops offending fails until
 * it is deleted here — this list can only shrink, never silently rot.
 *
 * Deliberately NOT auto-corrected: each needs a meaning, not a spelling.
 */
const AWAITING_DECISION: Readonly<Record<string, string>> = {
  // CRM vocabulary with no def anywhere — should these defs EXIST?
  "synap/crm.md:linked_to_deal": "CRM verb, no def — seed or rewrite",
  "synap/crm.md:is_client": "role expressed as an edge; Kind+Facets says facet",
  "synap/crm.md:produced_by_deal": "CRM verb, no def — seed or rewrite",
  "synap/crm.md:member_of": "no def; `affiliated_with` is close but not equal",
  "synap/SKILL.md:linked_to_deal": "generated from crm.md",
  "synap/SKILL.md:is_client": "generated from crm.md",
  "synap/SKILL.md:produced_by_deal": "generated from crm.md",
  "synap/SKILL.md:member_of": "generated from crm.md",
  // Content OS
  "synap/content-os.md:belongs_to_pillar": "content verb, no def",
  // Research flow — `references` is the likely meaning, but that is a choice
  "synap/work-flow.md:source": "likely `references`; semantic, not a typo",
  "synap/SKILL.md:source": "generated from work-flow.md",
  // linking.md's "pick a type" table — semantic neighbours exist, none exact
  "synap/linking.md:child_of": "inverse of parent_of; directed defs only",
  "synap/linking.md:belongs_to": "no def",
  "synap/linking.md:authored_by": "inverse of created_by",
  "synap/linking.md:works_with": "no def; `knows` is not equal",
  "synap/linking.md:part_of": "no def (named in this file's own header)",
  "synap/linking.md:from_meeting": "no def; `met_at` is not equal",
  "synap/linking.md:anchored_in": "no def",
};

describe("TRIPWIRE: relation types taught in skill files must resolve", () => {
  const files = listSkillMarkdown(SKILLS_ROOT);
  const sites = files.flatMap((f) => harvestSkillFile(f, RESOLVABLE));
  const offenders = sites.filter((s) => !RESOLVABLE.has(s.token));
  const offenderKeys = new Set(offenders.map((s) => `${s.file}:${s.token}`));

  it("walked the skill tree (never vacuously green)", () => {
    expect(files.length).toBeGreaterThanOrEqual(50);
    expect(files.some((f) => f.endsWith("synap/linking.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("synap/capture.md"))).toBe(true);
  });

  it("harvested relation-type sites through every anchor", () => {
    expect(sites.length).toBeGreaterThanOrEqual(25);
    expect(new Set(sites.map((s) => s.token)).size).toBeGreaterThanOrEqual(10);
    // Self-check: capture.md's graph example (`"type": "works_at"` beside
    // `sourceRef`) must stay visible — anchor A going blind would drop it.
    expect(
      sites.some((s) => s.file === "synap/capture.md" && s.token === "works_at")
    ).toBe(true);
    // Anchor C: linking.md's table carries real slugs; it must be read.
    expect(
      sites.some(
        (s) => s.file === "synap/linking.md" && s.token === "relates_to"
      )
    ).toBe(true);
  });

  it("the harvest sees a planted defect (anchors are live, not decorative)", () => {
    const planted = [
      "```json",
      '{ "sourceEntityId": "a", "targetEntityId": "b", "type": "related_to" }',
      "```",
    ].join("\n");
    const tokens = [...planted.matchAll(MD_TYPE_VALUE)].map((m) => m[1]);
    expect(ENDPOINT_KEY.test(planted)).toBe(true);
    expect(tokens).toContain("related_to");
    expect(RESOLVABLE.has("related_to")).toBe(false);
  });

  it("teaches no unresolvable relation type outside the decision ratchet", () => {
    const unexpected = offenders
      .filter((s) => !(`${s.file}:${s.token}` in AWAITING_DECISION))
      .map((s) => `${s.at}: '${s.token}'`);
    expect(
      unexpected,
      "A skill file teaches a relation type no relation_def provides — every " +
        "agent that loads it gets its edges rejected. Use a slug from " +
        "DEFAULT_RELATION_DEFS; never add it to AWAITING_DECISION to go green."
    ).toEqual([]);
  });

  it("every AWAITING_DECISION entry is still a live offender (ratchet only shrinks)", () => {
    const stale = Object.keys(AWAITING_DECISION).filter(
      (k) => !offenderKeys.has(k)
    );
    expect(
      stale,
      "These entries no longer offend — delete them from AWAITING_DECISION."
    ).toEqual([]);
  });
});
