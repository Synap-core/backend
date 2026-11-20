/**
 * EVERY READER OF `category: "rule"` HANDLES A PROSE RULE.
 *
 * Decision D1 (founder, 20 Nov 2026, proposal 8d04d49e): a Rule is a guideline
 * PUSHED into every piece of work in its scope; one store, `skills`, with
 * `category: "rule"`. The pod's prose rules (`rules/start-here`,
 * `rules/ui-rules`…) are skills with NO `metadata.rule` blob. Every reader
 * written before D1 assumed a rule-loop row carrying that blob (knowledge
 * 24228ce5): the list doors dropped a prose rule, `getRule` 404'd it, and
 * marking the pod's rules as rules would have hidden them from the Rules list.
 *
 * ── WHAT THIS PINS ───────────────────────────────────────────────────────────
 * The READER SET is DERIVED (never hand-listed): every backend source file
 * that names `RULE_CATEGORY`, compares a category with "rule", or parses the
 * rule blob (`readRuleMetadata(` / `readRuleView(`). Each one must be
 * classified below with WHY it is right for a prose rule, and the evidence of
 * that handling must be present in its code (comments stripped):
 *   - a door that LISTS or SHOWS rules reads `readRuleView` (a prose rule is
 *     listed, as a rule, with its body as its words);
 *   - a door that EDITS through the rule loop names a prose rule and sends it
 *     to the skill door (`isProseRule` / `PROSE_RULE_EDIT_MESSAGE`);
 *   - a reader that compiles, activates or runs rules gates on the loop blob
 *     (`readRuleMetadata` or a `->'rule'->…` SQL path), which a prose rule
 *     never has, so it is skipped, never half-run.
 * A NEW reader fails here until someone decides what it does with a prose
 * rule. A classified file that stops reading rules fails too (stale entry).
 *
 * Behaviour is pinned beside each door: `routers/skills.prose-rule.test.ts`,
 * `routers/hub-protocol/rest/rules.test.ts`, `services/rules/update.test.ts`,
 * `services/rules/prose-rule.pglite.test.ts`,
 * `routers/mcp/handlers/build.update-skill.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const BACKEND = join(__dirname, "..", "..", "..", "..");
const ROOTS = ["packages", "apps"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".git",
  "coverage",
  "worktrees",
]);

/** What makes a source file a reader of the rule category. */
const READER =
  /RULE_CATEGORY|category,\s*["']rule["']|category\s*===?\s*["']rule["']|readRuleMetadata\(|readRuleView\(/;

/** The loop gate: a reader that only acts on rows carrying `metadata.rule`. */
const LOOP_GATE = /readRuleMetadata\(|->'rule'->/;

interface Handling {
  /** Why this reader is right for a prose rule. */
  why: string;
  /** Each must match the reader's comment-stripped source. */
  evidence: RegExp[];
  /** Per tRPC procedure: each must match that procedure's body. */
  procedures?: Record<string, RegExp[]>;
}

const READERS: Record<string, Handling> = {
  // ── Defines the forms ──────────────────────────────────────────────────
  "packages/api/src/services/rules/index.ts": {
    why: "defines RULE_CATEGORY, the loop blob reader, and readRuleView / isProseRule (the prose form)",
    evidence: [
      /export function readRuleView\(/,
      /export function isProseRule\(/,
    ],
  },

  // ── Lists or shows rules: a prose rule is listed, as a rule ────────────
  "packages/api/src/routers/skills.ts": {
    why: "listRules / getRule show a prose rule (form 'prose'); renewRule names the skill door; update refuses a category change that would break a rule; dryRun reads lineage edges, which a prose rule has none of",
    evidence: [],
    procedures: {
      listRules: [/readRuleView\(/],
      getRule: [/readRuleView\(/],
      renewRule: [/isProseRule\(/, /PROSE_RULE_EDIT_MESSAGE/],
      update: [/skillCategoryChangeProblem\(/],
      dryRunRule: [/readRuleAutomationIds\(/],
    },
  },
  "packages/api/src/routers/hub-protocol/rest/rules.ts": {
    why: "GET /rules lists a prose rule (form 'prose'), as skills.listRules does",
    evidence: [/readRuleView\(/],
  },
  "apps/pod-admin/lib/rule-skill.ts": {
    why: "pod admin's Rules list: the category alone makes a skill a rule (plus the rules/ slug stopgap, kept until the pod data is marked)",
    evidence: [/skill\.category === RULE_CATEGORY/],
  },

  // ── Edits through the rule loop: a prose rule goes to the skill door ───
  "packages/api/src/services/rules/update.ts": {
    why: "updateRuleGoverned rebuilds metadata.rule; a prose rule is refused with the skill door named",
    evidence: [/isProseRule\(/, /PROSE_RULE_EDIT_MESSAGE/],
  },
  "packages/api/src/utils/composite-update-caller.ts": {
    why: "an update_rule part needs the loop blob; a prose rule is refused, naming update_skill",
    evidence: [LOOP_GATE, /prose rule/],
  },
  "packages/api/src/services/rules/create.ts": {
    why: "the rule loop's WRITER: it creates loop rules with their blob, never reads a prose one",
    evidence: [/\[RULE_METADATA_KEY\]|RULE_METADATA_KEY\]/],
  },

  // ── Compile, activate or run: gated on the loop blob, prose skipped ────
  "packages/api/src/services/reactions/reaction-rule-rows.ts": {
    why: "reaction rules are rows with metadata.rule.reaction; a prose rule has no reaction",
    evidence: [/->'rule'->'reaction'/, /readRuleMetadata\(/],
  },
  "packages/api/src/services/playbooks/playbook-activators.ts": {
    why: "activator rules are rows with metadata.rule.seed; a prose rule has no seed",
    evidence: [/->'rule'->'seed'/, /readRuleMetadata\(/],
  },
  "packages/api/src/services/rules/template-rules.ts": {
    why: "template rules converge on metadata.rule.seed; a prose rule has no seed",
    evidence: [/->'rule'->'seed'/, /readRuleMetadata\(/],
  },
  "packages/api/src/services/playbooks/workers.ts": {
    why: "worker overlap and worker listing read metadata.rule.seed; a prose rule has none and no activates edge",
    evidence: [/readRuleMetadata\([^)]*\)\?\.seed/],
  },
  "packages/api/src/routers/automations.ts": {
    why: "an agent's run of a rule's automation checks the rule's expiry; a prose rule owns no automation",
    evidence: [LOOP_GATE],
  },
  "packages/api/src/services/workspace-to-package-definition.ts": {
    why: "a package's rules[] carries rule-loop rules (intent + sentence); a prose rule is a skill, and workspace skills are not exported, so it is skipped, never converted into a loop rule",
    evidence: [/readRuleMetadata\([^)]*\);\s*if \(!meta\) continue/],
  },

  // ── Not a skills reader / counts prose as a skill ──────────────────────
  "packages/api/src/services/proposals/pending-rules.ts": {
    why: "reads pending rule/create PROPOSALS (target_type 'rule'), not skills rows; a category change is a skill/update proposal",
    evidence: [/const RULE_TARGET_TYPE = RULE_CATEGORY/],
  },
  "packages/api/src/services/skills/same-name-skill.ts": {
    why: "a prose rule is written through the skill doors, so it counts as a twin; only a rule-loop rule is left out",
    evidence: [/->'rule' IS NULL/],
  },
};

function walk(dir: string, found: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, found);
    } else if (
      /\.tsx?$/.test(e.name) &&
      !/\.test\.tsx?$/.test(e.name) &&
      !e.name.endsWith(".d.ts") &&
      !e.name.includes(".generated.")
    ) {
      found.push(full);
    }
  }
  return found;
}

function source(rel: string): string {
  return stripComments(readFileSync(join(BACKEND, rel), "utf8"), "ts");
}

/** The body of the named tRPC procedure, up to the next procedure. */
function procedureBody(src: string, name: string): string {
  const at = src.search(
    new RegExp(`\\n {2}${name}: (?:protected|workspace|public)Procedure`)
  );
  if (at === -1) throw new Error(`procedure not found: ${name}`);
  const next = src
    .slice(at + 1)
    .search(/\n {2}[a-zA-Z]+: (?:protected|workspace|public)Procedure/);
  return next === -1 ? src.slice(at) : src.slice(at, at + 1 + next);
}

const derived = ROOTS.flatMap((r) => walk(join(BACKEND, r), []))
  .map((abs) => relative(BACKEND, abs))
  .filter((rel) => READER.test(source(rel)))
  .sort();

describe("every reader of category 'rule' handles a prose rule", () => {
  it("finds the readers (non-vacuous)", () => {
    // The two list doors and the rule loop's own module are readers by
    // construction: a derivation that misses them is broken, not empty.
    expect(derived).toEqual(
      expect.arrayContaining([
        "packages/api/src/routers/skills.ts",
        "packages/api/src/routers/hub-protocol/rest/rules.ts",
        "packages/api/src/services/rules/index.ts",
      ])
    );
  });

  it("every reader is classified", () => {
    const unclassified = derived.filter((rel) => !(rel in READERS));
    expect(
      unclassified,
      'A new reader of `category: "rule"`. Decide what it does with a PROSE ' +
        "rule (category 'rule', no `metadata.rule`): list it through " +
        "`readRuleView`, refuse it in words through `isProseRule`, or gate on " +
        "the loop blob — then classify it in READERS with why."
    ).toEqual([]);
  });

  it("no classified file has stopped reading rules", () => {
    const stale = Object.keys(READERS).filter((rel) => !derived.includes(rel));
    expect(stale, "remove these entries from READERS").toEqual([]);
  });

  for (const [rel, handling] of Object.entries(READERS)) {
    it(`${rel} — ${handling.why}`, () => {
      if (!derived.includes(rel)) return; // reported by the stale check
      const src = source(rel);
      for (const pattern of handling.evidence) {
        expect(src, `${rel} lost ${pattern}`).toMatch(pattern);
      }
      for (const [name, patterns] of Object.entries(
        handling.procedures ?? {}
      )) {
        const body = procedureBody(src, name);
        for (const pattern of patterns) {
          expect(body, `${rel} ${name} lost ${pattern}`).toMatch(pattern);
        }
      }
    });
  }
});
