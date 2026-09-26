/**
 * TRIPWIRE — the concept words have ONE definition (`skills/synap/concepts.md`).
 *
 * Concept-consolidation W1 (2026-09-25). Before it, "project", "workspace",
 * "template" and "pack" were defined in five skill files, the IS prompt, the CLI
 * and the team docs — and they disagreed ("a project is a company/initiative",
 * "a workspace is just a lens", "workspace (≡ template)"). The glossary is the
 * one answer; this keeps it the one answer.
 *
 * FOUR checks:
 *   1. Every glossary row (word) is CLASSIFIED against the vocabulary door
 *      (`@synap-core/types/vocabulary`): aligned (the registry label IS the user
 *      word), derived (template nouns), pending-W5 (a registry row the W5 naming
 *      pass will relabel), or no-row (with the reason). The heading set is
 *      DERIVED from the file, so a new concept joins by existing and fails until
 *      it is classified.
 *   2. The glossary reaches the doors: `_teaching.json` (alwaysOn — without an
 *      entry `ensureSystemSkills` defaults it to alwaysOn:false and it never
 *      reaches the IS prompt), `_order.txt`, and the assembled `SKILL.md`.
 *   3. Retired phrasings are ABSENT from every skill file, the IS prompt
 *      sections, the CLI source and the team docs.
 *   4. The files that used to define the words POINT at `concepts` instead.
 *
 * WHAT IT CANNOT SEE, stated rather than implied:
 *   - The aligned check proves SAMENESS between glossary and vocabulary, never
 *     correctness: if both said "Stage" it would pass.
 *   - A paraphrase of a retired phrasing. It pins the sentences that shipped.
 *   - Sibling repos (IS, CLI, synap-app docs) and the monorepo-root docs are read
 *     from disk and SKIPPED when absent (CI checks out this repo alone). Locally
 *     every one is present and the non-vacuity test fails if the local scan is
 *     empty.
 *   - The IS baseline mirror — held by the IS `baseline-drift.test.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveObjectLabel,
  resolveObjectNounPlural,
  resolveTemplateNoun,
} from "@synap-core/types/vocabulary";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");
const CONCEPTS = join(SKILLS_DIR, "synap/concepts.md");
const MONOREPO = resolve(HERE, "../../../../..");

// ── 1. classification ────────────────────────────────────────────────────────

/** The registry label IS the user word. */
const ALIGNED: Record<string, string> = {
  Workspace: "workspace",
  Project: "project",
  Track: "track",
  Step: "stage",
  Pack: "pack",
  Rule: "automation",
};
/**
 * The glossary word is the registry's PLURAL label — "Tools" is one word for
 * three DB kinds (skill, capability, tool; founder D2), so every one of them
 * must carry it. Landed in the W5 naming pass (was PENDING_W5).
 */
const ALIGNED_PLURAL: Record<string, readonly string[]> = {
  Tools: ["capability", "skill", "tool"],
};
/** No registry row carries this word, and why. */
const NO_ROW: Record<string, string> = {
  Template: "derived — resolveTemplateNoun(scope), checked below",
  Work: "no noun by design; the action is 'Start work'",
  Approvals: "governance rules are not an object kind in the registry",
  "To review":
    "list-header COPY over the `proposal` kind (vocabulary.md: copy is not vocabulary)",
  Role: "a facet / role profile, resolved per profile, not a static kind",
};

function glossaryHeadings(): string[] {
  // One table row per concept: `| **Word** | internal | … |`.
  return [
    ...readFileSync(CONCEPTS, "utf8").matchAll(/^\| \*\*(.+?)\*\* \|/gm),
  ].map((m) => m[1]!.trim());
}

describe("tripwire: concepts.md is classified against the vocabulary", () => {
  const headings = glossaryHeadings();

  it("non-vacuity: the glossary has its concepts", () => {
    expect(headings.length).toBeGreaterThanOrEqual(10);
    expect(headings).toContain("Project");
  });

  it("every heading is classified (a new concept fails until it is)", () => {
    const classified = new Set([
      ...Object.keys(ALIGNED),
      ...Object.keys(ALIGNED_PLURAL),
      ...Object.keys(NO_ROW),
    ]);
    expect(headings.filter((h) => !classified.has(h))).toEqual([]);
    // …and nothing is classified that the glossary no longer defines.
    expect([...classified].filter((c) => !headings.includes(c))).toEqual([]);
  });

  it("aligned words ARE the vocabulary label", () => {
    for (const [word, kind] of Object.entries(ALIGNED)) {
      expect(resolveObjectLabel(kind), `${word} ↔ ${kind}`).toBe(word);
    }
  });

  it("plural-aligned words are the plural label of EVERY kind behind them", () => {
    for (const [word, kinds] of Object.entries(ALIGNED_PLURAL)) {
      for (const kind of kinds) {
        expect(resolveObjectNounPlural(kind), `${word} ↔ ${kind}`).toBe(word);
      }
    }
  });

  it("the template nouns the glossary names are the vocabulary's", () => {
    const text = readFileSync(CONCEPTS, "utf8").toLowerCase();
    for (const scope of ["session", "project"] as const) {
      expect(text).toContain(resolveTemplateNoun(scope).toLowerCase());
    }
  });
});

// ── 2. delivery ──────────────────────────────────────────────────────────────

describe("tripwire: the glossary reaches every door", () => {
  it("_teaching.json carries it alwaysOn (else the IS prompt never sees it)", () => {
    const json = JSON.parse(
      readFileSync(join(SKILLS_DIR, "_teaching.json"), "utf8")
    ) as Record<string, { alwaysOn?: boolean } | string>;
    const entry = json["synap/concepts"];
    expect(entry, "no _teaching.json entry for synap/concepts").toBeTruthy();
    expect((entry as { alwaysOn?: boolean }).alwaysOn).toBe(true);
  });

  it("_order.txt assembles it and SKILL.md was rebuilt with it", () => {
    const order = readFileSync(join(SKILLS_DIR, "synap/_order.txt"), "utf8");
    expect(order.split("\n").map((l) => l.trim())).toContain("concepts.md");
    const bundle = readFileSync(join(SKILLS_DIR, "synap/SKILL.md"), "utf8");
    const firstLine = readFileSync(CONCEPTS, "utf8").split("\n")[0]!;
    expect(bundle).toContain(firstLine);
  });
});

// ── 3. retired phrasings ─────────────────────────────────────────────────────

const RETIRED: RegExp[] = [
  /company\s*\/\s*initiative/i,
  /workspace is just a lens/i,
  /engagement blueprint/i,
  /container for a line of work/i,
  /workspace\*{0,2}\s*\(≡ template\)/i,
  /triggered project/i,
  /the session template/i,
  /reusable session template/i,
];

function filesUnder(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return filesUnder(p, ext);
    return ext.test(name) ? [p] : [];
  });
}

/** Whitespace collapsed, so a phrase wrapped across lines still matches. */
function flat(path: string): string {
  return readFileSync(path, "utf8").replace(/\s+/g, " ");
}

const SIBLING_FILES = [
  join(
    MONOREPO,
    "synap-intelligence-service/apps/intelligence-hub/src/agents/base/prompt-sections.ts"
  ),
  join(MONOREPO, "NORTH-STAR.md"),
  join(MONOREPO, "TEMPLATE-DEV-GUIDE.md"),
  join(
    MONOREPO,
    "synap-app/synap-team-docs/content/team/platform/playbooks-capability-substrate.mdx"
  ),
  ...filesUnder(join(MONOREPO, "synap-cli/src"), /\.ts$/),
].filter((p) => existsSync(p));

describe("tripwire: retired concept phrasings are gone", () => {
  const skillFiles = filesUnder(SKILLS_DIR, /\.md$/);

  it("non-vacuity: the skills corpus and (locally) the siblings are scanned", () => {
    expect(skillFiles.length).toBeGreaterThan(40);
    expect(skillFiles.map((f) => relative(SKILLS_DIR, f))).toContain(
      "synap/SKILL.md"
    );
    // Locally the monorepo is present; in a lone-repo CI checkout it is not.
    if (existsSync(join(MONOREPO, "synap-intelligence-service"))) {
      expect(SIBLING_FILES.length).toBeGreaterThan(10);
    }
  });

  it("SELF-GUARD: each detector fires on the sentence it retired", () => {
    const samples = [
      "a project is a company/initiative that ties workspaces together",
      "A workspace is just a lens; a project is a cross-cutting lens",
      '`"project"` — an ENGAGEMENT BLUEPRINT: its ordered stages',
      "A project is a container for a line of work.",
      "| **workspace** (≡ template) | a whole domain",
      "via facets + a triggered project — NEVER workspaces",
      "### 4.2 Playbook (the session template — new first-class table)",
      "as a reusable session template — so next time",
    ];
    RETIRED.forEach((re, i) =>
      expect(re.test(samples[i]!), String(re)).toBe(true)
    );
  });

  it("no skill, IS prompt, CLI or team doc carries a retired phrasing", () => {
    const offenders = [...skillFiles, ...SIBLING_FILES].flatMap((f) => {
      const text = flat(f);
      return RETIRED.filter((re) => re.test(text)).map(
        (re) => `${relative(MONOREPO, f)}: ${re}`
      );
    });
    expect(
      offenders,
      "Concept words are defined once in skills/synap/concepts.md — point there instead."
    ).toEqual([]);
  });
});

// ── 4. pointers ──────────────────────────────────────────────────────────────

describe("tripwire: former definition sites point at the glossary", () => {
  it.each([
    "synap/lenses.md",
    "synap/mental-model.md",
    "synap/from-intent.md",
    "synap/workspace-design.md",
    "synap-market/overview.md",
    "synap/reflexes.md",
  ])("%s names `concepts`", (file) => {
    expect(readFileSync(join(SKILLS_DIR, file), "utf8")).toContain("concepts");
  });
});
