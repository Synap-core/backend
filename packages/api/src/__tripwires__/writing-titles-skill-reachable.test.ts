/**
 * TRIPWIRE — the title rules REACH an agent (plan 9992207a, c-system-skill).
 *
 * Acceptance: "a fresh agent on a fresh pod finds the rule within orient + one
 * load_skill". Before this, an MCP-only agent could not learn how to title:
 * no skill covered it, `ask "naming conventions"` returned nothing, and the
 * knowledge profile said nothing about what is NOT knowledge.
 *
 * Checked, each as a reachability fact rather than a shape:
 *   1. orient's `startHere.learnMore.writing` names a slug that resolves to a
 *      real seeded file (`system/<pkg>/<stem>` → `skills/<pkg>/<stem>.md`).
 *   2. The file is seeded and taught: in `_order.txt`, in `_teaching.json`
 *      with `autoSeed` + `cliBundle` and teaching the write tools (the summary
 *      line is what lands in those tools' descriptions), and in the assembled
 *      `SKILL.md` the CLI and IS read.
 *   3. The three pages an agent reads before writing point at it.
 *   4. The numbers it teaches are the rubric's numbers (`@synap-core/types/
 *      titles`) — a skill that says 80 while the lint says 70 would teach one
 *      rule and enforce another.
 *
 * NOT covered: that the pod's boot seeder actually ran (a deploy fact), and
 * the CLI / IS mirrors of this file (held by the CLI `skills-baseline-parity`
 * and the IS `baseline-drift` tests).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  QUESTION_TITLE_SOFT_MAX,
  TITLE_HARD_MAX,
  TITLE_SOFT_MAX,
} from "@synap-core/types/titles";
import { ORIENT_WRITING_SKILL } from "../services/discover/start-here.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(HERE, "../../../../skills");

const [, pkg, stem] = ORIENT_WRITING_SKILL.split("/");
const FILE = join(SKILLS_DIR, pkg!, `${stem}.md`);
const read = (p: string) => readFileSync(p, "utf8");

describe("the writing-titles skill is reachable from orient", () => {
  it("orient's pointer resolves to a seeded skill file", () => {
    expect(ORIENT_WRITING_SKILL).toMatch(/^system\/[a-z-]+\/[a-z-]+$/);
    expect(existsSync(FILE), `${FILE} is missing`).toBe(true);
    expect(read(FILE)).toMatch(/^## Writing titles and knowledge/m);
  });

  it("is in the package order, taught, and in the assembled SKILL.md", () => {
    const order = read(join(SKILLS_DIR, pkg!, "_order.txt"))
      .split("\n")
      .map((l) => l.trim());
    expect(order).toContain(`${stem}.md`);

    const teaching = JSON.parse(read(join(SKILLS_DIR, "_teaching.json")))[
      `${pkg}/${stem}`
    ];
    expect(teaching, "no _teaching.json entry").toBeTruthy();
    expect(teaching.delivery).toMatchObject({ autoSeed: true, cliBundle: true });
    for (const tool of ["synap_capture", "create_entity", "update_entity"]) {
      expect(teaching.teachesTools).toContain(tool);
    }
    expect(teaching.summary).toMatch(/≤ 80/);

    expect(read(join(SKILLS_DIR, pkg!, "SKILL.md"))).toContain(
      "## Writing titles and knowledge"
    );
  });

  it.each(["capture.md", "writes.md", "quick-reference.md"])(
    "%s points at it",
    (page) => {
      expect(read(join(SKILLS_DIR, pkg!, page))).toContain(stem!);
    }
  );

  it("teaches the rubric's own numbers", () => {
    const body = read(FILE);
    expect(body).toContain(`${TITLE_SOFT_MAX} characters at most`);
    expect(body).toContain(`a question\n   may take ${QUESTION_TITLE_SOFT_MAX}`);
    expect(body).toContain(`over\n${TITLE_HARD_MAX} characters it refuses`);
  });

  it("teaches the decided knowledge forms and routing targets", () => {
    const body = read(FILE);
    for (const form of ["`fact`", "`caution`", "`convention`"]) {
      expect(body).toContain(form);
    }
    for (const kind of ["`decision`", "`issue`", "`note`", "`research`"]) {
      expect(body).toContain(kind);
    }
  });
});
