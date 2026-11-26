/**
 * TRIPWIRE — a retired skill topic is a redirect, and nothing points at it.
 *
 * Surfaces P8b (26 Nov 2026): `synap-ui/four-builds` and `synap/viewframe-cells`
 * moved into the `surfaces` skill. Their files stay as short redirect stubs, so
 * the `system/<pkg>/<stem>` rows already seeded on every pod heal to a pointer
 * (`ensureSystemSkills` re-projects a changed file and never deletes a row):
 * deleting them would leave the old teaching live on every pod. A stub is only
 * a landing spot, so an agent must never be SENT to one: a skill that points
 * at a retired topic hands the agent a redirect instead of the lesson.
 *
 * WHAT IS CHECKED, per retired topic:
 *   1. its package's `_order.txt` does not assemble it (the bundle never
 *      carries a redirect);
 *   2. its `_teaching.json` entry teaches no tool (it never ranks for one);
 *   3. no other skill text names it: every `*.md` under `skills/` (the
 *      assembled `SKILL.md` bundles and the package readmes included), every `_skill.yaml`,
 *      every other `_teaching.json` summary, and every MCP tool description in
 *      the committed manifest (the served wire text).
 *
 * THE SETS ARE DERIVED: a retired topic is any topic file whose first line
 * starts `## Retired:`; the scanned files are walked from disk.
 *
 * WHAT IT CANNOT SEE: sibling repos (the CLI's help text, the IS baseline
 * copies), pod-authored skills, and a pointer that names the topic only in
 * prose ("the four builds chapter").
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");
const MANIFEST = resolve(HERE, "../routers/mcp/tools/mcp-tools.manifest.json");
const RETIRED_MARK = /^## Retired:/;

interface Topic {
  pkg: string;
  stem: string;
  file: string;
}

function packages(): string[] {
  return readdirSync(SKILLS_DIR).filter((d) =>
    statSync(join(SKILLS_DIR, d)).isDirectory()
  );
}

/** Every topic file whose first line marks it retired. */
function retiredTopics(): Topic[] {
  return packages().flatMap((pkg) =>
    readdirSync(join(SKILLS_DIR, pkg))
      // A bundle opens with frontmatter and a readme with its title: only a
      // stub carries the mark, so no file needs excluding by name.
      .filter((f) => f.endsWith(".md"))
      .filter((f) =>
        RETIRED_MARK.test(readFileSync(join(SKILLS_DIR, pkg, f), "utf8"))
      )
      .map((f) => ({
        pkg,
        stem: f.slice(0, -3),
        file: join(SKILLS_DIR, pkg, f),
      }))
  );
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return name.endsWith(".md") || name === "_skill.yaml" ? [p] : [];
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pointer at `pkg/stem`: the slug or path, the file name, or the bare stem in backticks. */
export function pointsAt(text: string, topic: Pick<Topic, "pkg" | "stem">) {
  const stem = escape(topic.stem);
  return new RegExp(
    `${escape(topic.pkg)}/${stem}\\b|\\b${stem}\\.md\\b|\`${stem}\``,
    "i"
  ).test(text);
}

describe("tripwire: retired skill topics are redirects nobody points at", () => {
  const retired = retiredTopics();

  it("non-vacuity: the known retired topics are found by their mark", () => {
    const keys = retired.map((t) => `${t.pkg}/${t.stem}`);
    expect(keys).toContain("synap/viewframe-cells");
    expect(keys).toContain("synap-ui/four-builds");
  });

  it("SELF-GUARD: the detector fires on a pointer and spares the new home", () => {
    const vf = { pkg: "synap", stem: "viewframe-cells" };
    for (const line of [
      "Recipe: `synap-ui`; params and shapes: `viewframe-cells`.",
      'load synap_load_skill("system/synap/viewframe-cells")',
      "teach that (skills/synap/viewframe-cells.md)",
      "Targets and scopes: system/synap/viewframe-cells.",
    ]) {
      expect(pointsAt(line, vf), line).toBe(true);
    }
    for (const line of [
      "Recipe: `system/surfaces/cells` and `system/surfaces/cell-authoring`.",
      "the four builds a person can ask for",
    ]) {
      expect(pointsAt(line, vf), line).toBe(false);
    }
  });

  it("a retired topic is not assembled into its package's SKILL.md", () => {
    const assembled = retired.filter((t) =>
      readFileSync(join(SKILLS_DIR, t.pkg, "_order.txt"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .includes(`${t.stem}.md`)
    );
    expect(assembled.map((t) => `${t.pkg}/${t.stem}`)).toEqual([]);
  });

  it("a retired topic teaches no tool", () => {
    const teaching = JSON.parse(
      readFileSync(join(SKILLS_DIR, "_teaching.json"), "utf8")
    ) as Record<string, { teachesTools?: string[] } | string>;
    const teaches = retired.filter((t) => {
      const entry = teaching[`${t.pkg}/${t.stem}`];
      return typeof entry === "object" && (entry.teachesTools ?? []).length > 0;
    });
    expect(teaches.map((t) => `${t.pkg}/${t.stem}`)).toEqual([]);
  });

  it("no skill text, teaching summary or tool description points at a retired topic", () => {
    const files = walk(SKILLS_DIR);
    expect(files.length).toBeGreaterThan(60);
    const teaching = JSON.parse(
      readFileSync(join(SKILLS_DIR, "_teaching.json"), "utf8")
    ) as Record<string, { summary?: string } | string>;
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      tools: Array<{ name: string; description: string }>;
    };
    expect(manifest.tools.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const topic of retired) {
      const self = `${topic.pkg}/${topic.stem}`;
      for (const f of files) {
        if (f === topic.file) continue;
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (pointsAt(line, topic))
            offenders.push(`${relative(SKILLS_DIR, f)}:${i + 1} → ${self}`);
        });
      }
      for (const [key, entry] of Object.entries(teaching)) {
        if (key === self || typeof entry !== "object") continue;
        if (pointsAt(entry.summary ?? "", topic))
          offenders.push(`_teaching.json ${key} → ${self}`);
      }
      for (const tool of manifest.tools) {
        if (pointsAt(tool.description, topic))
          offenders.push(`tool ${tool.name} → ${self}`);
      }
    }
    expect(
      offenders,
      "A retired topic is a redirect: point at the topic that replaced it (its stub names it)."
    ).toEqual([]);
  });
});
