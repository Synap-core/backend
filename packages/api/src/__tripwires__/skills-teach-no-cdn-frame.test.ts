/**
 * TRIPWIRE — cell-building skills never teach an agent to load code from a CDN.
 *
 * ONE frame policy everywhere (founder, 2026-11-03, "R3"): a generated cell's
 * frame gets React, react-dom, the JSX runtimes and `@synap/kit` from the HOST
 * and fetches no code from the network (no esm.sh, no CDN script, no web font).
 * The web and desktop frames REFUSE a cell whose `deps` resolve through esm.sh
 * (`ViewFrame.tsx` `frameNetworkCodeRefusal`), yet the skills still taught
 * "`deps` resolve through esm.sh", so agents produced cells that were refused.
 *
 * WHAT IS CHECKED: no line of any skill file (or `_teaching.json`) names a code
 * CDN or font host UNLESS the line carries a negation ("no", "never", "not",
 * "refused", "without", "nor"): "no CDN, no esm.sh"
 * is the policy being taught, "resolved via the esm.sh import map" is the
 * retired lesson. A second pattern catches the retired `deps` import-map lesson
 * even when the host is not named.
 *
 * THE SET IS DERIVED: every `*.md` under `synap-backend/skills/` (the generated
 * `SKILL.md` included, so a rebuild that was never run is caught) plus
 * `_teaching.json`.
 *
 * WHAT IT CANNOT SEE: the CLI's own help text (sibling repo) and a paraphrase
 * that names no host and no import map.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");

const CDN_HOST =
  /esm\.sh|esm\.run|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|cdn\.skypack\.dev|skypack\.dev|ga\.jspm\.io|cdn\.tailwindcss\.com|code\.jquery\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/i;
const NEGATION = /\b(no|never|not|refused|refuses|without|nor)\b/i;
/** The retired lesson that `deps` feed an import map. */
const DEPS_IMPORT_MAP =
  /\bdeps\b[^\n]*import[ -]?map|import[ -]?map[^\n]*\bdeps\b/i;

/** Lines that teach loading code from a CDN (or through a deps import map). */
export function cdnTeachingLines(text: string): string[] {
  return text.split("\n").filter((line) => {
    const host = CDN_HOST.exec(line);
    if (host && !NEGATION.test(line)) return true;
    const map = DEPS_IMPORT_MAP.exec(line);
    return !!map && !NEGATION.test(line);
  });
}

function skillFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return skillFiles(p);
    return name.endsWith(".md") || name === "_teaching.json" ? [p] : [];
  });
}

describe("tripwire: skills never teach loading code from a CDN", () => {
  const files = skillFiles(SKILLS_DIR);

  it("scans a plausible skills corpus", () => {
    const rel = files.map((f) => relative(SKILLS_DIR, f));
    expect(files.length).toBeGreaterThan(40);
    expect(rel).toContain("synap/viewframe-cells.md");
    expect(rel).toContain("_teaching.json");
  });

  it("SELF-GUARD: the detector fires on the retired lessons and spares the policy", () => {
    const retired = [
      "- Bare imports (`react`, `recharts`) are resolved via the esm.sh import map generated from `deps`.",
      "`deps` pins npm packages for the esm.sh import map.",
      '"recharts": "https://esm.sh/recharts@2.12.0",',
      '<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>',
      "Each key in `deps` becomes a bare specifier in the import map.",
    ];
    for (const line of retired) {
      expect(cdnTeachingLines(line), line).toHaveLength(1);
    }
    const policy = [
      "The frame loads no code from the network (no CDN, no esm.sh).",
      "Never load a font from fonts.googleapis.com.",
      "A cell that names esm.sh is refused.",
    ];
    for (const line of policy) {
      expect(cdnTeachingLines(line), line).toHaveLength(0);
    }
  });

  it("no skill file teaches esm.sh, a CDN host or a deps import map", () => {
    const offenders = files.flatMap((f) =>
      cdnTeachingLines(readFileSync(f, "utf8")).map(
        (line) => `${relative(SKILLS_DIR, f)}: ${line.trim().slice(0, 120)}`
      )
    );
    expect(
      offenders,
      "a frame gets React and @synap/kit from the host and loads no code from the network; teach that (skills/synap/viewframe-cells.md)"
    ).toEqual([]);
  });
});
