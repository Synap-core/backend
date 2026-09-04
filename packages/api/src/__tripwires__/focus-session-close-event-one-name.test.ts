/**
 * TRIPWIRE — the focus-session close event has ONE name.
 *
 * Closing a session is the seam three consumers meet at: the automation trigger
 * matcher (`@synap/jobs`), the unblock reactor, and the persisted `events` row
 * the Why spine reads. A seam that many parties agree on by spelling the same
 * string in four places is not a seam, it is four strings that happen to match
 * today — and the failure mode is silent: a producer renames its literal, every
 * consumer keeps compiling, and nothing fires again. That has already happened
 * on this codebase (a class matched `run` while the executor wrote
 * `capability.run`, and the tests pinned the same lie).
 *
 * The SSOT is `services/focus-sessions/close-event.ts`, which composes the type
 * from a subject-type half and an action half so the string is never typed out.
 * `complete-session.ts` — the only close door — must reach it through those
 * constants, and no other file in `@synap/api` or `@synap/jobs` may spell it.
 *
 * The matcher is the ONE sanctioned exception: `@synap/api` depends on
 * `@synap/jobs`, so the matcher cannot import the SSOT without closing a cycle.
 * It mirrors the value instead, and this file parses BOTH sides and fails the
 * moment they differ — a pinned copy, not a drifting one.
 *
 * Source-parsed on purpose: it must fail in CI without a database, at the point
 * of EDIT rather than when an automation quietly stops firing in production.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_CLOSE_ACTION,
  FOCUS_SESSION_CLOSED_EVENT_TYPE,
} from "../services/focus-sessions/close-event.js";

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "..");
const JOBS_SRC = join(here, "..", "..", "..", "jobs", "src");

const CLOSE_EVENT = join(API_SRC, "services/focus-sessions/close-event.ts");
const COMPLETE = join(API_SRC, "services/focus-sessions/complete-session.ts");
const MATCHER = join(JOBS_SRC, "workers/automation-trigger-matcher.ts");

/** The two files allowed to carry the literal, and why each one is allowed. */
const SANCTIONED = new Map<string, string>([
  [
    CLOSE_EVENT,
    "the SSOT itself (and it does not spell the joined string either — it composes it)",
  ],
  [
    MATCHER,
    "the pinned mirror: @synap/api depends on @synap/jobs, so the matcher cannot import the SSOT",
  ],
]);

/**
 * Strip comments before scanning. A doc comment NAMING the event ("reacts to
 * `focus_session.closed`") is how a consumer explains itself, not a second
 * spelling of the contract — the reactor and the barrel both do exactly that.
 * Only CODE can drift.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules" || name === "__tripwires__")
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

const SOURCES = [...walk(API_SRC), ...walk(JOBS_SRC)];

describe("tripwire: the focus-session close event has one name", () => {
  it("the scan actually found both packages (a vacuous scan is not a tripwire)", () => {
    // Self-guard. A moved directory would leave SOURCES empty and every
    // absence-assertion below would pass by finding nothing at all.
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(SOURCES).toContain(COMPLETE);
    expect(SOURCES).toContain(MATCHER);
  });

  it("the close door emits through the constants, never a literal", () => {
    const src = readFileSync(COMPLETE, "utf8");

    // It reaches the SSOT module...
    expect(src).toMatch(/from "\.\/close-event\.js"/);

    // ...the persisted history row is typed by the constant...
    expect(src).toMatch(
      /logEvent\([\s\S]{0,200}?FOCUS_SESSION_CLOSED_EVENT_TYPE/
    );

    // ...and the transient reactor hop composes the SAME two halves, so the
    // emitted `subjectType.action.completed` and the persisted type cannot
    // diverge. Pinning both halves is the point: `emitSideEffects` builds the
    // type itself, so a literal here would be invisible to the check above.
    const emit = src.match(/emitSideEffects\(\{[\s\S]*?\n  \}\);/);
    expect(
      emit,
      "no emitSideEffects call found in the close door"
    ).not.toBeNull();
    expect(emit![0]).toContain(`subjectType: FOCUS_SESSION_SUBJECT_TYPE`);
    expect(emit![0]).toContain(`action: FOCUS_SESSION_CLOSE_ACTION`);
  });

  it("BOTH halves are emitted — a reactor hop alone leaves no history", () => {
    // The transient emit reaches the matcher and dies with the job. Only the
    // `events` row is readable afterwards. Shipping one without the other is
    // the integration-continent defect (live firing, no persisted trace).
    const src = readFileSync(COMPLETE, "utf8");
    expect(src).toMatch(/\bemitSideEffects\(/);
    expect(src).toMatch(/\blogEvent\(/);
  });

  it("no other file in @synap/api or @synap/jobs spells the event", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (SANCTIONED.has(file)) continue;
      const src = code(readFileSync(file, "utf8"));
      if (
        src.includes(
          `${FOCUS_SESSION_SUBJECT_TYPE}.${FOCUS_SESSION_CLOSE_ACTION}`
        ) ||
        // Both spellings a producer or a consumer would reach for: emitting
        // `action: "closed"`, and a reactor comparing `payload.action === "closed"`.
        /action:\s*"closed"|action\s*===?\s*"closed"/.test(src)
      ) {
        offenders.push(relative(join(here, "..", "..", "..", ".."), file));
      }
    }
    expect(
      { offenders },
      "Import FOCUS_SESSION_CLOSED_EVENT_TYPE / FOCUS_SESSION_CLOSE_ACTION " +
        "from services/focus-sessions/close-event.ts instead of spelling the " +
        "event. A hand-typed copy is how a producer and its consumers come to " +
        "disagree while both keep compiling."
    ).toEqual({ offenders: [] });
  });

  it("the matcher's mirror is byte-identical to the SSOT", () => {
    const src = readFileSync(MATCHER, "utf8");
    const mirror = src.match(/FOCUS_SESSION_CLOSED_EVENT_TYPE\s*=\s*"([^"]+)"/);
    expect(
      mirror,
      "the matcher no longer declares a FOCUS_SESSION_CLOSED_EVENT_TYPE mirror — " +
        "if it now imports the SSOT, delete this assertion and the SANCTIONED entry"
    ).not.toBeNull();
    expect(mirror![1]).toBe(FOCUS_SESSION_CLOSED_EVENT_TYPE);
  });

  it("the matcher branches on the constant, not on a re-spelled string", () => {
    const src = readFileSync(MATCHER, "utf8");
    // The branch must USE the name. Without this, the mirror could sit unread
    // beside a literal comparison and the parity check above would still pass.
    expect(src).toMatch(/if \(eventType === FOCUS_SESSION_CLOSED_EVENT_TYPE\)/);
  });

  it("the SSOT composes the type — it never types the joined string", () => {
    const src = code(readFileSync(CLOSE_EVENT, "utf8"));
    expect(src).not.toContain(
      `"${FOCUS_SESSION_SUBJECT_TYPE}.${FOCUS_SESSION_CLOSE_ACTION}`
    );
    expect(src).toContain("${FOCUS_SESSION_SUBJECT_TYPE}");
    expect(src).toContain("${FOCUS_SESSION_CLOSE_ACTION}");
  });
});
