/**
 * TRIPWIRE — the conductor skill teaches the three rules a capable agent broke.
 *
 * On 2026-09-19 an AI built a large structure pack on the live pod and: filed
 * 14 separate proposals where the plan door files ONE (exhausting the pending
 * cap, then re-creating two playbooks as duplicates when it worked around the
 * refusal), declared no acceptance criteria, and self-graded "85% complete".
 * Every primitive it needed already existed, and `from-intent.md` already said
 * to open the session first. The prose was not carrying its weight, so three
 * rules were written into the places an agent is reading AT the moment each
 * one matters. This keeps them there — and keeps the generated bundle in sync.
 *
 * TWO DIRECTIONS, as in `skills-teach-playbook-fetch-first.test.ts`: the rule
 * must be PRESENT in the topic file, and the same sentence must appear in the
 * GENERATED `synap/SKILL.md` — which is what external agents actually load.
 * A topic file edited without running `node skills/build.mjs` ships an
 * unchanged bundle, so the second half is the one that catches a real miss.
 *
 * THE SET IS DERIVED: every `*.md` under `synap-backend/skills/`, so the
 * corpus assertion cannot silently shrink to nothing.
 *
 * WHAT IT CANNOT SEE, measured:
 *   - the MCP tool descriptions (`routers/mcp/tools/index.ts`) carry the same
 *     three rules for agents that never load a skill. Nothing holds those to
 *     these files; they are prose in a different file and are not scanned here.
 *   - the IS baseline mirror (sibling repo, held by its own
 *     `src/skills/baseline-drift.test.ts`). True by construction: the scan
 *     root is `synap-backend/skills`.
 *   - a PARAPHRASE. This pins anchor sentences, not the idea. Reword the
 *     paragraph and the tripwire goes red — that is the intended cost of
 *     editing a rule that was written because an agent ignored the old one.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");
const FROM_INTENT = join(SKILLS_DIR, "synap/from-intent.md");
const FOCUS_SESSIONS = join(SKILLS_DIR, "synap/focus-sessions.md");
const BUNDLE = join(SKILLS_DIR, "synap/SKILL.md");

/**
 * Each rule is located by a needle that MUST appear on exactly one line of the
 * topic file; that whole line is then required verbatim in the bundle. Pinning
 * the line (not the needle) is what makes the bundle half non-vacuous: a stale
 * SKILL.md still contains the old needle-free paragraph, never this line.
 */
const RULES = [
  {
    rule: "structure work is ONE plan, not N proposals",
    file: FROM_INTENT,
    needle: "The trigger is countable",
  },
  {
    rule: "the plan's objects ARE the expected outputs",
    file: FROM_INTENT,
    needle: "Name what the work will produce",
  },
  {
    rule: "propose the session's criteria (conductor)",
    file: FROM_INTENT,
    needle: "Propose its `criteria`",
  },
  {
    rule: "a detour is a CHILD session with parentSessionId + suspendedIntent",
    file: FROM_INTENT,
    needle: "A detour is a CHILD session",
  },
  {
    rule: "propose the session's criteria (sessions topic)",
    file: FOCUS_SESSIONS,
    needle: "Propose them yourself",
  },
  {
    rule: "declare expected outputs (sessions topic)",
    file: FOCUS_SESSIONS,
    needle: "Declare what the work will produce",
  },
] as const;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return markdownFiles(p);
    return name.endsWith(".md") ? [p] : [];
  });
}

function soleLineContaining(text: string, needle: string): string[] {
  return text.split("\n").filter((l) => l.includes(needle));
}

describe("tripwire: the conductor teaches plan / criteria / outputs", () => {
  const files = markdownFiles(SKILLS_DIR);

  it("scans a plausible skills corpus", () => {
    // A glob that matched nothing passes every assertion after it.
    expect(files.length).toBeGreaterThan(40);
    const rel = files.map((f) => relative(SKILLS_DIR, f));
    expect(rel).toContain("synap/from-intent.md");
    expect(rel).toContain("synap/focus-sessions.md");
    expect(rel).toContain("synap/SKILL.md");
  });

  it("SELF-GUARD: the locator still finds a line, and rejects a missing one", () => {
    const sample = "a\n**The trigger is countable, so count.** …\nb";
    expect(soleLineContaining(sample, "The trigger is countable")).toHaveLength(
      1
    );
    expect(soleLineContaining(sample, "no such sentence")).toHaveLength(0);
  });

  it.each(RULES)(
    "$rule — the topic file states it once",
    ({ file, needle }) => {
      const lines = soleLineContaining(readFileSync(file, "utf8"), needle);
      expect(
        lines,
        `${relative(SKILLS_DIR, file)} must carry this rule on exactly one line`
      ).toHaveLength(1);
      // Not a heading or a bare anchor: the rule has to say something.
      expect(lines[0]!.trim().length).toBeGreaterThan(80);
    }
  );

  it.each(RULES)(
    "$rule — the generated SKILL.md carries the same line (the bundle was rebuilt)",
    ({ file, needle }) => {
      const line = soleLineContaining(readFileSync(file, "utf8"), needle)[0];
      expect(line, "topic file lost the rule").toBeTruthy();
      expect(
        readFileSync(BUNDLE, "utf8"),
        "synap/SKILL.md is stale — run `node skills/build.mjs` from synap-backend"
      ).toContain(line!.trim());
    }
  );
});
