/**
 * TRIPWIRE: the "one-off long plan" section is REACHABLE from the conductor's
 * classification, not merely written somewhere.
 *
 * WHY THIS EXISTS. On 21 Nov 2026 an agent laid out a real one-off long plan
 * ("fund Synap to seed": 19 steps, 5 decisions) and had to discover by trial
 * how to shape it. No skill said that a plan lived once is a root session with
 * child sessions, not a playbook. Worse, a step a year away topped the
 * person's needs-you because it declared a person-owed output at plan time.
 * The teaching now lives in ONE place, `from-intent` §2d, and is pointed at
 * from the "Classify first" table (the decision an agent takes before its
 * first write), from `work-model` and from `multi-entity-capture`'s second
 * plan example. This file holds each of those links, and the bundle that
 * ships them.
 *
 * REACHABILITY, not shape: the classify row must name §2d AND §2d must exist
 * as a heading in the same file; a row pointing at a removed section, or a
 * section no row points at, both fail.
 *
 * NEGATIVE CONTROL, measured (21 Nov 2026): with §2d deleted, the row kept and
 * the bundle NOT rebuilt, the first version stayed green on two tests: the
 * bundle test (an empty section is contained in any bundle) and the pointer
 * test (it read the pointers, never their target). Both now check the target.
 *
 * WHAT IT CANNOT SEE, stated rather than implied:
 *   - that an agent reads or obeys it (the limit of every prose guard here);
 *   - the IS baseline mirror and the CLI copy (sibling repos, held by
 *     `baseline-drift.test.ts` and `skills-baseline-parity.test.ts`);
 *   - a paraphrase: it pins anchor tokens, so a reword goes red by design;
 *   - correctness of the facts taught. It only pins that the section does NOT
 *     teach words still waiting on a founder decision (list below). When one
 *     is decided, edit the list in the same change as the section.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../skills/synap"
);
const read = (f: string): string => readFileSync(join(PKG, f), "utf8");

const HEADING = "### 2d. A one-off long plan";
const ROW_LABEL = "**one-off plan**";

/** The text between `start` (inclusive) and the next `### ` heading. */
function sectionFrom(src: string, start: string): string {
  const i = src.indexOf(start);
  if (i < 0) return "";
  const next = src.indexOf("\n### ", i + start.length);
  return next < 0 ? src.slice(i) : src.slice(i, next);
}

function classifyTable(src: string): string {
  const start = src.indexOf("### Classify first");
  const end = src.indexOf("### 0.");
  return start >= 0 && end > start ? src.slice(start, end) : "";
}

describe("tripwire: the one-off long plan is reachable from from-intent", () => {
  it("NON-VACUITY: the package and its chapter list are real", () => {
    const order = read("_order.txt")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(order.length).toBeGreaterThan(20);
    for (const f of [
      "from-intent.md",
      "work-model.md",
      "multi-entity-capture.md",
    ]) {
      expect(order, `${f} ships in the bundle`).toContain(f);
      expect(existsSync(join(PKG, f))).toBe(true);
    }
    // The classify table is found and is the real one (it has the old rows).
    const table = classifyTable(read("from-intent.md"));
    expect(table.length).toBeGreaterThan(500);
    expect(table).toContain("**session**");
    expect(table).toContain("**goal**");
  });

  it("SELF-GUARD: the section slicer finds a section, and nothing when it is gone", () => {
    const sample = `a\n${HEADING}\nbody blockedByRefs\n### 3. next\nz`;
    expect(sectionFrom(sample, HEADING)).toContain("blockedByRefs");
    expect(sectionFrom(sample, HEADING)).not.toContain("### 3.");
    expect(sectionFrom("a\n### 3. next", HEADING)).toBe("");
  });

  it("the classify table has a one-off plan row that points at §2d, and §2d exists", () => {
    const src = read("from-intent.md");
    const row = classifyTable(src)
      .split("\n")
      .find((l) => l.includes(ROW_LABEL));
    expect(row, "a classify row for the one-off plan").toBeTruthy();
    expect(row).toContain("§2d");
    expect(row).toContain("synap_capture");
    expect(row).toMatch(/playbook/);
    // The pointer resolves: the heading it names is in the same file, after §2c.
    const at = src.indexOf(`\n${HEADING}\n`);
    expect(at, "the §2d heading the row points at").toBeGreaterThan(0);
    expect(at).toBeGreaterThan(src.indexOf("### 2c."));
    expect(at).toBeLessThan(src.indexOf("### 3."));
  });

  it("§2d teaches the layout and the needs-you rule", () => {
    const s = sectionFrom(read("from-intent.md"), HEADING);
    expect(s.length).toBeGreaterThan(1500);
    // Tell it apart from a playbook, a session and a goal.
    expect(s).toMatch(/playbook/);
    expect(s).toMatch(/a goal \(§2c\)/);
    // ONE capture: root + children + waits + criteria/outputs + subject.
    for (const token of [
      "`synap_capture`",
      "`sessions[]`",
      "`parentRef`",
      "`blockedByRefs`",
      "`criteria`",
      "`expectedOutputs`",
      "`subjectEntityId`",
      "`decision`",
      '`decisionStatus: "proposed"`',
    ]) {
      expect(s, `§2d names ${token}`).toContain(token);
    }
    // The real cause of the noise, and the rule.
    expect(s).toContain('`owner: "human"`');
    expect(s).toMatch(/only when it can start/);
    // How a step waits: delivered clears, cancelled or failed holds.
    expect(s).toMatch(/delivered/);
    expect(s).toMatch(/cancelled or failed/);
    // A proposed decision's ask is not the proposals count.
    expect(s).toMatch(/counts pending proposals/);
  });

  it("§2d teaches nothing a pending founder decision may make false", () => {
    const s = sectionFrom(read("from-intent.md"), HEADING);
    expect(s.length, "non-vacuity").toBeGreaterThan(1500);
    // D-P1/D-P4 (what "planned" is), D-P7 (goals in a plan), D-P5 (arms),
    // r2 gap A (pausing does NOT hide a step from needs-you).
    for (const word of [
      "`forming`",
      "`scheduled`",
      "tracks[]",
      "trackRef",
      '"paused"',
      "excludes",
    ]) {
      expect(s, `§2d must not teach ${word} yet`).not.toContain(word);
    }
    // No new product word until `concepts` defines it (vocabulary first).
    if (!/\*\*Pathway\*\*/i.test(read("concepts.md"))) {
      expect(s).not.toMatch(/pathway/i);
    }
  });

  it("work-model and multi-entity-capture point at §2d, and §2d is there", () => {
    // A pointer is only reachable if its target exists: a removed §2d must
    // fail here too, not leave two pointers to nowhere.
    expect(read("from-intent.md")).toContain(`\n${HEADING}\n`);
    const wm = read("work-model.md")
      .split("\n")
      .find((l) => l.includes("one-off long plan"));
    expect(wm, "work-model names the one-off long plan").toBeTruthy();
    expect(wm).toContain("`from-intent` §2d");

    const mec = read("multi-entity-capture.md");
    const ex = mec.indexOf("PLAN EXAMPLE 2");
    expect(ex, "a second plan example").toBeGreaterThan(0);
    const body = mec.slice(
      ex,
      mec.indexOf("```", mec.indexOf("```json", ex) + 7)
    );
    expect(body).toContain("`from-intent` §2d");
    expect(body).toContain('"blockedByRefs"');
    expect(body).toContain('"profileSlug": "decision"');
    expect(body).not.toContain('"owner": "human"');
  });

  it("the generated SKILL.md carries the row, the section and the pointers (bundle rebuilt)", () => {
    const bundle = read("SKILL.md");
    const src = read("from-intent.md");
    const row = classifyTable(src)
      .split("\n")
      .find((l) => l.includes(ROW_LABEL));
    expect(row).toBeTruthy();
    // Non-vacuity: an empty section is contained in any bundle.
    const section = sectionFrom(src, HEADING).trim();
    expect(section.length).toBeGreaterThan(1500);
    const stale =
      "synap/SKILL.md is stale: run `node skills/build.mjs` from synap-backend";
    expect(bundle, stale).toContain(row!.trim());
    expect(bundle, stale).toContain(section);
    const wm = read("work-model.md")
      .split("\n")
      .find((l) => l.includes("one-off long plan"));
    expect(bundle, stale).toContain(wm!.trim());
    expect(bundle, stale).toContain("PLAN EXAMPLE 2");
  });
});
