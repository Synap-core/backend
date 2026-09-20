/**
 * TRIPWIRE — the skills teach FETCH-FIRST, and never re-teach auto-apply.
 *
 * Until 2026-09-20 `skills/synap/focus-sessions.md` opened with "Templates
 * apply themselves, and say so." That one line taught every agent that
 * discovery was the SERVER's job, which is the opposite of the founder's
 * rule ("make sure AIs always fetch session playbooks before creating a
 * session") — and the auto-apply it described had bound 0 of 6 work sessions
 * on the live pod. The code path is gone; this keeps the prose from drifting
 * back, and — the half that matters — keeps the REPLACEMENT present.
 *
 * TWO DIRECTIONS, because absence alone proves nothing: deleting the whole
 * paragraph would satisfy a "the lie is gone" assertion while leaving agents
 * with no instruction at all.
 *
 * THE SET IS DERIVED: every `*.md` under `synap-backend/skills/`, so a new
 * topic file joins this scan by existing. `SKILL.md` is generated from the
 * topic files by `skills/build.mjs`, and it is scanned too — a rebuild that
 * was never run is exactly how a fixed topic file ships an unfixed bundle.
 *
 * WHAT IT CANNOT SEE, measured:
 *   - the IS prompt section (`agents/base/prompt-sections.ts`) and the IS
 *     baseline mirror live in the sibling repo; the mirror is held to these
 *     files by `src/skills/baseline-drift.test.ts` there, the prompt section
 *     by nothing. True by construction: the scan root is
 *     `synap-backend/skills`, so nothing in the sibling repo is readable
 *     from here at all.
 *   - a paraphrase. It pins the retired sentence and the reflex's anchor
 *     words, not the idea.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");
const FOCUS_SESSIONS = join(SKILLS_DIR, "synap/focus-sessions.md");

/** The retired teaching, verbatim, plus the shape it would come back as. */
const RETIRED = [
  /templates apply themselves/i,
  /applied only (when|above)[^.]*confiden/i,
  /apply automatically/i,
];

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return markdownFiles(p);
    return name.endsWith(".md") ? [p] : [];
  });
}

describe("tripwire: skills teach fetch-first, not auto-apply", () => {
  const files = markdownFiles(SKILLS_DIR);

  it("scans a plausible skills corpus", () => {
    // A glob that matched nothing passes every assertion after it.
    expect(files.length).toBeGreaterThan(40);
    expect(files.map((f) => relative(SKILLS_DIR, f))).toContain(
      "synap/focus-sessions.md"
    );
    expect(files.map((f) => relative(SKILLS_DIR, f))).toContain(
      "synap/SKILL.md"
    );
  });

  it("SELF-GUARD: the detector still fires on the retired sentence", () => {
    const sample =
      "**Templates apply themselves, and say so.** Without `templateId`, a matching playbook is applied only when the match is confident;";
    expect(RETIRED.some((re) => re.test(sample))).toBe(true);
  });

  it("no skill file teaches that a playbook applies itself", () => {
    const offenders = files
      .map((f) => ({
        f: relative(SKILLS_DIR, f),
        text: readFileSync(f, "utf8"),
      }))
      .filter(({ text }) => RETIRED.some((re) => re.test(text)))
      .map(({ f }) => f);
    expect(
      offenders,
      "The start door applies NOTHING (services/focus-sessions/match-session-template.ts). " +
        "A skill that says otherwise teaches agents to wait for a bind that never comes."
    ).toEqual([]);
  });

  it("the focus-sessions skill DOES teach the fetch-first reflex", () => {
    // Absence of the lie is not presence of the instruction.
    const text = readFileSync(FOCUS_SESSIONS, "utf8");
    expect(text).toMatch(/playbooks`? block|`playbooks`/);
    expect(text).toMatch(/candidates/);
    expect(text).toMatch(/templateId/);
  });

  it("the generated SKILL.md carries the same reflex (the bundle was rebuilt)", () => {
    const bundle = readFileSync(join(SKILLS_DIR, "synap/SKILL.md"), "utf8");
    const topic = readFileSync(FOCUS_SESSIONS, "utf8");
    const line = topic
      .split("\n")
      .find((l) => l.includes("Fetch the pod's processes"));
    expect(
      line,
      "focus-sessions.md no longer opens with the reflex"
    ).toBeTruthy();
    expect(bundle).toContain(line!.trim());
  });
});
