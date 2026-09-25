/**
 * TRIPWIRE — every door that can hand a session slot to the PERSON tells them
 * (`session.needs_you`), or is classified as deliberately not telling them.
 *
 * The defect this exists for (research brief 2026-09-25, M1): an agent filing
 * an `owner: 'human'` slot put it in the needs-you tray and said nothing — the
 * person saw it only by opening the app and looking, so a cloud/background
 * session waiting on them simply stalled. The fix is ONE producer,
 * `notifySessionNeedsYou` (`services/focus-sessions/notify-needs-you.ts`).
 * A door added tomorrow that hands work over without it re-opens the silence.
 *
 * THE SET IS DERIVED, never hand-listed: a door is any non-test source file
 * under `src/` whose (comment-stripped) code does one of:
 *   - calls a slot writer: `stampBlocked`, `applyOutputMutations`,
 *     `mergeExpectedOutputs`, `sanitizeDeclaredOutputs` (the same writer set
 *     `block-guidance-every-door.test.ts` derives from);
 *   - calls `guidanceForBlockedSlots(` — the existing "this write may have
 *     just blocked a slot on the human" marker;
 *   - mints a person-owned slot: an `owner: "human"` property literal, or a
 *     `paramOwedSlots(` call;
 *   - births a playbook run carrying the playbook's declared slots:
 *     `instantiateSession(` / `instantiateSessionRow(`.
 * Every such file must call `notifySessionNeedsYou(` or appear in EXEMPT with
 * its reason.
 *
 * WHAT THIS DOES NOT SEE, measured and stated:
 *   - Granularity is the FILE, not the call site: a second hand-off function
 *     added to a file that already notifies stays green.
 *   - A write that stores `expectedOutputs` without any of the markers above
 *     (a raw insert of a caller-supplied array, e.g. `openRunSession` in
 *     `@synap/database`, which lives outside `packages/api/src`) is invisible.
 *   - It proves the call EXISTS, not that the actor rule is right; the
 *     behaviour (agent notifies, person does not, once per window) is pinned
 *     by `services/focus-sessions/__tests__/notify-needs-you.pglite.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const API_SRC = join(__dirname, "..");

const HANDOFF =
  /(?<!function\s)\b(stampBlocked|applyOutputMutations|mergeExpectedOutputs|sanitizeDeclaredOutputs|guidanceForBlockedSlots|paramOwedSlots|instantiateSession|instantiateSessionRow)\s*\(|^\s*owner:\s*"human"/m;
const NOTIFY = /(?<!function\s)\bnotifySessionNeedsYou\s*\(/;

/** Files that hand slots to the person but deliberately do NOT notify. */
const EXEMPT: Record<string, string> = {
  "routers/focus-sessions.ts":
    "tRPC — the PERSON's own editor. Its `blockOutput` still reaches the " +
    "producer inside `blockExpectedOutput` (with `ctx.agentUserId`); `update` " +
    "and `create` are the person writing their own session, which is never news.",
  "routers/proposals/executors/focus-session.ts":
    "The approval executor applies a hand-off a HUMAN just approved — they are " +
    "looking at it; a push about their own click is noise.",
  "services/focus-sessions/evaluations/record.ts":
    "Files the escalated-criterion slot and raises its OWN push " +
    "(`session.criterion_escalated`, same `if`, session-deduped). A second " +
    "type here would be two pushes for one event.",
  "services/focus-sessions/param-slots.ts":
    "Pure shape builder (no write). Persisted by `create-session.ts` (notifies) " +
    "and the approval executor (exempt above).",
  "services/playbooks/playbook-lifecycle.ts":
    "DEFINES `instantiateSession(Row)`; the notification belongs to the DOOR " +
    "that knows who is in front of the run (`run-playbook.ts` notifies).",
  "services/focus-sessions/schedule-session.ts":
    "An APPOINTMENT the person booked themselves (origin 'human').",
  "routers/playbooks.ts":
    "tRPC `playbooks.run` — the person clicking Run with a form in front of them.",
  "services/import/session.ts":
    "The person's own import of a session; nothing is handed over by an agent.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (
        name === "node_modules" ||
        name === "dist" ||
        name === "__tests__" ||
        name === "__tripwires__"
      )
        continue;
      walk(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const doors = walk(API_SRC)
  .map((abs) => ({
    rel: relative(API_SRC, abs),
    code: stripComments(readFileSync(abs, "utf8")),
  }))
  .filter((f) => HANDOFF.test(f.code));

describe("needs-you — every hand-off door tells the person", () => {
  it("the scan can still see what it hunts (self-check)", () => {
    expect(HANDOFF.test("x = mergeExpectedOutputs(a, b)")).toBe(true);
    expect(HANDOFF.test('  {\n    owner: "human" as const,\n')).toBe(true);
    expect(HANDOFF.test("await instantiateSession({")).toBe(true);
    expect(HANDOFF.test("export function mergeExpectedOutputs(")).toBe(false);
    expect(HANDOFF.test('message: `declared it owner: "human", so`')).toBe(
      false
    );
    expect(NOTIFY.test("await notifySessionNeedsYou({")).toBe(true);
    expect(stripComments("a // notifySessionNeedsYou(")).not.toMatch(NOTIFY);
  });

  it("the derived door set is non-vacuous and contains the known doors", () => {
    const rels = doors.map((d) => d.rel);
    expect(rels.length).toBeGreaterThanOrEqual(12);
    for (const known of [
      "services/focus-sessions/block-output.ts",
      "services/focus-sessions/update-session.ts",
      "services/focus-sessions/create-session.ts",
      "services/focus-sessions/follow-playbook.ts",
      "services/playbooks/run-playbook.ts",
      "routers/hub-protocol/rest/focus-sessions.ts",
    ]) {
      expect(rels).toContain(known);
    }
  });

  it("every door calls notifySessionNeedsYou or is classified EXEMPT", () => {
    const uncovered = doors
      .filter((d) => !NOTIFY.test(d.code) && !(d.rel in EXEMPT))
      .map((d) => d.rel);
    expect(uncovered).toEqual([]);
  });

  it("every EXEMPT entry is still a door and does not notify (no stale exemptions)", () => {
    const byRel = new Map(doors.map((d) => [d.rel, d]));
    expect(Object.keys(EXEMPT).filter((k) => !byRel.has(k))).toEqual([]);
    // An exempt file that DOES notify is mis-classified — move it out.
    expect(
      Object.keys(EXEMPT).filter((k) => NOTIFY.test(byRel.get(k)?.code ?? ""))
    ).toEqual([]);
  });
});
