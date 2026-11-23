/**
 * TRIPWIRE: the pathway section (a one-off long plan) is REACHABLE from the
 * conductor's classification, teaches the pathway model that shipped, and its
 * worked example is a plan the pod's own validators accept.
 *
 * WHY THIS EXISTS. On 21 Nov 2026 an agent laid out a real one-off long plan
 * ("fund Synap to seed": 19 steps, 5 decisions) and had to discover by trial
 * how to shape it. No skill said that a plan lived once is a root session with
 * child sessions, not a playbook. Worse, a step a year away topped the
 * person's needs-you because it declared a person-owed output at plan time.
 * The teaching lives in ONE place, `from-intent` §2d, and is pointed at from
 * the "Classify first" table (the decision an agent takes before its first
 * write), from `work-model`, from the `concepts` glossary row "Pathway" and
 * from `multi-entity-capture`'s second plan example. This file holds each of
 * those links, and the bundle that ships them.
 *
 * 23 Nov 2026 (lane S2): the interim §2d was replaced by the full section once
 * the pathway model landed: goals in the plan (`tracks[]`, `trackRef`, #1269),
 * steps born planned (`forming`, `startNow`, `plannedFor`/`dueBy`, #1264,
 * #1268), decision arms and the timeout default (#1280), measured milestones
 * (`measure.check`, #1266), cross-kind waits and re-plan edits (#1270).
 *
 * REACHABILITY, not shape: the classify row must name §2d AND §2d must exist
 * as a heading in the same file; a row pointing at a removed section, or a
 * section no row points at, both fail. The example is PARSED and run through
 * the real criteria schema, the real step-date rule and the real arm parser,
 * so an example the pod would refuse fails here.
 *
 * NEGATIVE CONTROL, measured (21 Nov 2026): with §2d deleted, the row kept and
 * the bundle NOT rebuilt, the first version stayed green on two tests: the
 * bundle test (an empty section is contained in any bundle) and the pointer
 * test (it read the pointers, never their target). Both now check the target.
 * 23 Nov 2026: with the interim §2d put back (topic files at their base
 * versions, this file kept), it goes red; see the S2 PR for the run.
 *
 * WHAT IT CANNOT SEE, stated rather than implied:
 *   - that an agent reads or obeys it (the limit of every prose guard here);
 *   - the IS baseline mirror and the CLI copy (sibling repos, held by
 *     `baseline-drift.test.ts` and `skills-baseline-parity.test.ts`);
 *   - a paraphrase: it pins anchor tokens, so a reword goes red by design;
 *   - the plan door itself: it checks the example's criteria, dates and arm
 *     options with the pod's validators, not the whole capture preflight
 *     (refs, cycles, ownership need a database). `synap_capture` with
 *     `validate: true` on a pod is the full check;
 *   - correctness of the prose beyond those checks. It pins that the section
 *     does NOT teach words still waiting on a founder decision or denied to
 *     agents (list below). When one changes, edit the list with the section.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArmRef } from "@synap-core/types/connections";
import {
  PLANNED_SESSION_STATUS,
  TRACK_WORK_KINDS,
  isStepDate,
} from "@synap-core/types/units";
import { sessionCriteriaSchema } from "../schemas/session-criteria.js";
import {
  MEASURE_CHECK_VERB,
  MEASURE_OPS,
} from "../services/capabilities/measure-check.js";

const PKG = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../skills/synap"
);
const read = (f: string): string => readFileSync(join(PKG, f), "utf8");

const HEADING = "### 2d. A pathway: a one-off long plan";
const ROW_LABEL = "**pathway**";

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

/** PLAN EXAMPLE 2's prose and its JSON block (`null` when either is gone). */
function planExample2(): { prose: string; json: string } | null {
  const mec = read("multi-entity-capture.md");
  const at = mec.indexOf("PLAN EXAMPLE 2");
  if (at < 0) return null;
  const open = mec.indexOf("```json", at);
  const close = open < 0 ? -1 : mec.indexOf("```", open + 7);
  if (open < 0 || close < 0) return null;
  return { prose: mec.slice(at, open), json: mec.slice(open + 7, close) };
}

interface ExampleSession {
  ref: string;
  parentRef?: string;
  trackRef?: string;
  blockedByRefs?: string[];
  plannedFor?: string;
  dueBy?: string;
  criteria?: unknown[];
  expectedOutputs?: Array<Record<string, unknown>>;
}
interface ExamplePlan {
  tracks?: Array<{
    ref: string;
    workKind?: string;
    criteria?: unknown[];
  }>;
  sessions?: ExampleSession[];
  entities?: Array<{
    ref?: string;
    profileSlug: string;
    properties?: Record<string, unknown>;
  }>;
  links?: Array<{
    type: string;
    fromRef?: string;
    toEntityRef?: string;
  }>;
}

describe("tripwire: the pathway is reachable from from-intent", () => {
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
      "concepts.md",
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

  it("the classify table has a pathway row that points at §2d, and §2d exists", () => {
    const src = read("from-intent.md");
    const row = classifyTable(src)
      .split("\n")
      .find((l) => l.includes(ROW_LABEL));
    expect(row, "a classify row for the pathway").toBeTruthy();
    expect(row).toContain("§2d");
    expect(row).toContain("synap_capture");
    expect(row).toContain("`tracks[]`");
    expect(row).toMatch(/playbook/);
    // The pointer resolves: the heading it names is in the same file, after §2c.
    const at = src.indexOf(`\n${HEADING}\n`);
    expect(at, "the §2d heading the row points at").toBeGreaterThan(0);
    expect(at).toBeGreaterThan(src.indexOf("### 2c."));
    expect(at).toBeLessThan(src.indexOf("### 3."));
  });

  it("§2d teaches the layout: classify, one capture with the goal, steps, decisions", () => {
    const s = sectionFrom(read("from-intent.md"), HEADING);
    expect(s.length).toBeGreaterThan(4000);
    // Tell it apart from a playbook, a session and a goal.
    expect(s).toMatch(/playbook/);
    expect(s).toMatch(/a goal \(§2c\)/);
    // ONE capture: the goal, root + children + waits + criteria/outputs + subject.
    for (const token of [
      "`synap_capture`",
      "`tracks[]`",
      '`workKind: "pathway"`',
      "`trackRef`",
      "`sessions[]`",
      "`parentRef`",
      "`blockedByRefs`",
      "`criteria`",
      "`expectedOutputs`",
      "`subjectEntityId`",
      "`links[]`",
      '"toEntityRef"',
      "`toTrackRef`",
      "`decision`",
      '`decisionStatus: "proposed"`',
    ]) {
      expect(s, `§2d names ${token}`).toContain(token);
    }
    // A proposed decision's ask is not the proposals count.
    expect(s).toMatch(/counts pending proposals/);
  });

  it("§2d teaches born planned, dates and how a step waits", () => {
    const s = sectionFrom(read("from-intent.md"), HEADING);
    expect(s).toMatch(/born planned/);
    expect(s).toMatch(/owes nothing/);
    for (const token of ["`startNow: true`", "`plannedFor`", "`dueBy`"]) {
      expect(s, `§2d names ${token}`).toContain(token);
    }
    // The date forms it teaches are the ones the step-date rule accepts.
    for (const date of ["2027-03", "2027-03-14"]) {
      expect(s).toContain(`\`${date}\``);
      expect(isStepDate(date), `${date} is a step date`).toBe(true);
    }
    // Planning a started step back names THE planned status.
    expect(PLANNED_SESSION_STATUS).toBe("forming");
    expect(s).toContain(`\`status: "${PLANNED_SESSION_STATUS}"\``);
    // Delivered clears; cancelled, failed or rejected holds.
    expect(s).toMatch(/delivered/);
    expect(s).toMatch(/cancelled or failed/);
    expect(s).toContain("`blocker_dropped`");
    // The real cause of the noise, and the rule.
    expect(s).toContain('`owner: "human"`');
    expect(s).toMatch(/Declare the person's part only when a step can start/);
  });

  it("§2d teaches decision arms and who may set the default", () => {
    const s = sectionFrom(read("from-intent.md"), HEADING);
    expect(s).toContain("`<decision id>:<option>`");
    expect(s).toMatch(/skipped/);
    expect(s).toMatch(/no arm matches/i);
    expect(s).toContain('`addBlockedByEntityIds: ["<decision id>:<option>"]`');
    // The arm form it teaches is the one the door parses.
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseArmRef(`${id}:angels`)).toEqual({ id, option: "angels" });
    expect(s).toContain("`answerBy`");
    expect(s).toContain("`defaultOption`");
    expect(s).toMatch(/only if the PERSON set it/);
  });

  it("§2d teaches measured milestones with every measure op the verb runs", () => {
    const s = sectionFrom(read("from-intent.md"), HEADING);
    expect(s).toContain(`\`${MEASURE_CHECK_VERB}\``);
    // Derived from the verb: a new op the text does not name fails here.
    expect(MEASURE_OPS.length).toBeGreaterThanOrEqual(4);
    for (const op of MEASURE_OPS) {
      expect(s, `§2d names the measure op ${op}`).toContain(`\`${op}\``);
    }
    // Its inline example is a criterion the session door accepts.
    const m = s.match(/`("check": \{[^`]+\})`/);
    expect(m, "an inline measure.check criterion").toBeTruthy();
    const check = (JSON.parse(`{${m![1]}}`) as { check: unknown }).check;
    const parsed = sessionCriteriaSchema.safeParse([
      { key: "forty-investors", statement: "Forty investors", check },
    ]);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("§2d teaches the re-plan through the person, and nothing an agent is denied", () => {
    const s = sectionFrom(read("from-intent.md"), HEADING);
    expect(s).toMatch(/an agent cannot remove one/);
    for (const token of [
      "`edits[]`",
      '"op": "remove_link"',
      '"op": "update_session"',
      "`synap_revise_proposal`",
      "`synap_get_work_graph`",
      "`rootSessionId`",
    ]) {
      expect(s, `§2d names ${token}`).toContain(token);
    }
    // Denied to agents by design (grant: no link.delete), or not built
    // (`excludes`), or not "planned" (`scheduled` is an appointment, a pause
    // does not hide a step): never taught here.
    for (const word of [
      "removeBlockedBy",
      "`scheduled`",
      '"paused"',
      "excludes",
      "hold.until",
    ]) {
      expect(s, `§2d must not teach ${word}`).not.toContain(word);
    }
  });

  it("the glossary defines Pathway and points at §2d", () => {
    const row = read("concepts.md")
      .split("\n")
      .find((l) => /^\| \*\*Pathway\*\* +\|/.test(l));
    expect(row, "concepts has a Pathway row").toBeTruthy();
    expect(row).toContain("`from-intent` §2d");
    expect(row).toContain("workKind: pathway");
    expect(TRACK_WORK_KINDS).toContain("pathway");
    expect(read("from-intent.md")).toContain(`\n${HEADING}\n`);
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
    expect(wm).toContain("**pathway**");

    const ex = planExample2();
    expect(ex, "a second plan example with a JSON block").toBeTruthy();
    expect(ex!.prose).toContain("`from-intent` §2d");
    expect(ex!.json).not.toContain('"owner": "human"');
  });

  it("PLAN EXAMPLE 2 is a pathway the pod's validators accept", () => {
    const ex = planExample2();
    expect(ex).toBeTruthy();
    const plan = JSON.parse(ex!.json) as ExamplePlan;
    // The goal is in the plan, a pathway.
    const goal = plan.tracks?.[0];
    expect(goal, "a goal in tracks[]").toBeTruthy();
    expect(goal!.workKind).toBe("pathway");
    expect(TRACK_WORK_KINDS as readonly string[]).toContain(goal!.workKind);
    // A root and its steps; every step joins the goal and has criteria.
    const sessions = plan.sessions ?? [];
    expect(sessions.length).toBeGreaterThanOrEqual(5);
    const root = sessions.find((x) => !x.parentRef);
    expect(root, "one root session").toBeTruthy();
    const steps = sessions.filter((x) => x.parentRef === root!.ref);
    expect(steps.length).toBe(sessions.length - 1);
    for (const step of steps) {
      expect(step.trackRef, `${step.ref} joins the goal`).toBe(goal!.ref);
      const parsed = sessionCriteriaSchema.safeParse(step.criteria ?? []);
      expect(parsed.success, `${step.ref}: ${parsed.error?.message}`).toBe(
        true
      );
      expect(step.criteria?.length).toBeGreaterThanOrEqual(1);
      for (const key of ["plannedFor", "dueBy"] as const) {
        if (step[key] !== undefined) {
          expect(isStepDate(step[key]), `${step.ref}.${key}`).toBe(true);
        }
      }
    }
    expect(steps.some((x) => (x.blockedByRefs ?? []).length >= 2)).toBe(true);
    expect(steps.some((x) => x.plannedFor)).toBe(true);
    // The goal's criteria parse as a session's (start_track: "the same shape").
    const goalCriteria = sessionCriteriaSchema.safeParse(goal!.criteria ?? []);
    expect(goalCriteria.success, goalCriteria.error?.message).toBe(true);
    // A measured milestone.
    expect(ex!.json).toContain(`"capability": "${MEASURE_CHECK_VERB}"`);
    // A proposed decision whose options are the arms the prose names, each
    // arm step waiting on it through a cross-kind link.
    const decision = (plan.entities ?? []).find(
      (e) => e.profileSlug === "decision"
    );
    expect(decision?.properties?.decisionStatus).toBe("proposed");
    const options = (
      (decision!.properties!.decisionOptions as Array<{
        label: string;
        value?: string;
      }>) ?? []
    ).map((o) => o.value ?? o.label);
    expect(options.length).toBeGreaterThanOrEqual(2);
    const armLinks = (plan.links ?? []).filter(
      (l) => l.type === "blocked_by" && l.toEntityRef === decision!.ref
    );
    expect(armLinks.length).toBe(options.length);
    for (const option of options) {
      expect(ex!.prose, `the prose names the arm :${option}`).toContain(
        `:${option}`
      );
    }
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
    expect(section.length).toBeGreaterThan(4000);
    const stale =
      "synap/SKILL.md is stale: run `node skills/build.mjs` from synap-backend";
    expect(bundle, stale).toContain(row!.trim());
    expect(bundle, stale).toContain(section);
    const wm = read("work-model.md")
      .split("\n")
      .find((l) => l.includes("one-off long plan"));
    expect(bundle, stale).toContain(wm!.trim());
    const ex = planExample2();
    expect(bundle, stale).toContain(ex!.json.trim());
    const pathwayRow = read("concepts.md")
      .split("\n")
      .find((l) => /^\| \*\*Pathway\*\* +\|/.test(l));
    expect(bundle, stale).toContain(pathwayRow!.trim());
  });
});
