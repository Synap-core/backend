/**
 * TRIPWIRE — an agent takes a slot back through the relay door, never
 * through `unblockOutput`.
 *
 * `unblockOutput` refuses every agent key (403, `routers/focus-sessions.ts`
 * and the Hub `outputs/unblock` door): handing a person's slot back is the
 * person's act. Yet the focus-sessions skill and the block-guideline message
 * both told an agent "reclaim the slot (`unblockOutput`)", so an agent that
 * followed a guideline hit the 403 with nothing else to try. The door an agent
 * has is `synap_relay_answer` with `disposition: 'withdrawn'` + a `note`.
 *
 * TWO DIRECTIONS: the retired advice is gone from every skill file AND from
 * the block-guideline message, and the replacement is present in both.
 *
 * THE SET IS DERIVED: every `*.md` under `synap-backend/skills/` (the
 * generated `SKILL.md` included, so a rebuild that was never run is caught).
 *
 * WHAT IT CANNOT SEE: the IS and CLI mirrors (sibling repos), and a
 * paraphrase that names neither `unblockOutput` nor "reclaim the slot".
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");
const BLOCK_GUIDELINES = resolve(
  HERE,
  "../services/focus-sessions/block-guidelines.ts"
);

/** The retired advice: the door name, or the sentence it came in. */
const RETIRED = [/`?unblockOutput`?/, /reclaim the slot/i];
/** The replacement: the relay door, withdrawing. */
const REPLACEMENT = /synap_relay_answer[^\n]*withdrawn/;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return markdownFiles(p);
    return name.endsWith(".md") ? [p] : [];
  });
}

describe("tripwire: agents take a slot back through the relay door", () => {
  const files = markdownFiles(SKILLS_DIR);

  it("scans a plausible skills corpus", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.map((f) => relative(SKILLS_DIR, f))).toContain(
      "synap/focus-sessions.md"
    );
  });

  it("SELF-GUARD: the detector still fires on the retired sentence", () => {
    const sample =
      "If it lets you proceed, do the work and reclaim the slot (`unblockOutput`).";
    expect(RETIRED.some((re) => re.test(sample))).toBe(true);
  });

  it("no skill file teaches unblockOutput", () => {
    const offenders = files
      .filter((f) => RETIRED.some((re) => re.test(readFileSync(f, "utf8"))))
      .map((f) => relative(SKILLS_DIR, f));
    expect(
      offenders,
      "unblockOutput refuses an agent key; teach synap_relay_answer withdrawn"
    ).toEqual([]);
  });

  it("the focus-sessions skill and its bundle teach the withdraw", () => {
    for (const f of ["synap/focus-sessions.md", "synap/SKILL.md"]) {
      expect(readFileSync(join(SKILLS_DIR, f), "utf8")).toMatch(REPLACEMENT);
    }
  });

  it("the block-guideline message an agent reads names the relay door", () => {
    const src = readFileSync(BLOCK_GUIDELINES, "utf8");
    expect(RETIRED.some((re) => re.test(src))).toBe(false);
    expect(src).toMatch(REPLACEMENT);
  });
});
