/**
 * TRIPWIRE — every door that WRITES `focus_sessions.expected_outputs` either
 * keys the slots it writes, or is classified as one that only carries slots
 * it read (so their stored keys ride along on the spread).
 *
 * WHY. A slot's `key` (A2, `services/focus-sessions/slot-keys.ts`) is the
 * stable identity outcomes, artifact claims and governance slot claims join
 * on. A new write door that rebuilt the array without keying it would hand
 * back slots whose identity is re-derived from their label on every read —
 * and a reworded label would silently move an outcome's key.
 *
 * DERIVED, not hand-listed: the scanned set is every non-test file under
 * `src/` that runs `.insert(focusSessions)` / `.update(focusSessions)` AND
 * assigns an `expectedOutputs:` property. A new writer joins the scan by
 * existing, and is red until it is classified.
 *
 * WHAT IT DOES NOT SEE, measured: granularity is the FILE. A file that keys
 * one write and writes a raw array in another passes — reverting the stamp in
 * `create-session.ts` is caught (the file then names no keying door at all),
 * but adding a second, raw write beside a keyed one is not. The PRESERVES
 * class is a recorded claim ("spreads the stored slots"), not a proof; the
 * write-door reachability is proven behaviourally in
 * `services/focus-sessions/__tests__/slot-keys-doors.pglite.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

/** A keying door: the stamp itself, or a function that stamps on its way. */
const KEYS_SLOTS =
  /\b(stampSlotKeys|carrySlotKeys|updateExpectedOutputsLocked|mergeExpectedOutputs|applyOutputMutations)\b/;
const WRITES_SESSIONS = /\.(insert|update)\(focusSessions\)/;
/** An `expectedOutputs:` PROPERTY — not a select column, a type, or a schema. */
const ASSIGNS_OUTPUTS =
  /expectedOutputs\s*:(?!\s*(true\b|unknown\b|ExpectedOutput|Array<|OutputItem|z\.|focusSessions\.))/;

/** Writes that only CARRY slots they read — keys ride along. Reason required. */
const PRESERVES: Record<string, string> = {
  "services/focus-sessions/answer-pickup.ts":
    "stamps `answerPickedUpAt` onto a spread of each stored slot",
  "services/focus-sessions/satisfy-expected-output.ts":
    "stamps `done` / attestation onto a spread of the chosen stored slot",
  "services/focus-sessions/complete-session.ts":
    "retirement stamps `retiredAt` onto a spread of each stored slot",
  "services/focus-sessions/answer-slot.ts":
    "the answer door stamps `answer` onto a spread of the stored slot",
  "services/playbooks/run-playbook.ts":
    "`expectedOutputs:` is the playbook_runs definition snapshot, not a session slot write",
  "routers/sync.ts":
    "mirrors a peer pod's session row verbatim — the peer's keys are the row's keys",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (
        name === "__tests__" ||
        name === "__tripwires__" ||
        name === "node_modules"
      )
        continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const writers = walk(SRC)
  .filter((p) => {
    const src = readFileSync(p, "utf8");
    return WRITES_SESSIONS.test(src) && ASSIGNS_OUTPUTS.test(src);
  })
  .map((p) => relative(SRC, p).split("\\").join("/"))
  .sort();

describe("every expected_outputs write door keys its slots", () => {
  it("the scan is not vacuous, and can still see what it hunts", () => {
    expect(writers.length).toBeGreaterThanOrEqual(10);
    expect(writers).toContain("services/focus-sessions/create-session.ts");
    expect(writers).toContain("routers/sync.ts");
    // Self-check on literal samples, so a regex edit cannot blind the scan.
    expect(ASSIGNS_OUTPUTS.test("expectedOutputs: next,")).toBe(true);
    expect(ASSIGNS_OUTPUTS.test("expectedOutputs: true,")).toBe(false);
    expect(WRITES_SESSIONS.test("tx.update(focusSessions)")).toBe(true);
  });

  it("each writer keys its slots or is classified as carrying them", () => {
    const unclassified = writers.filter((rel) => {
      if (PRESERVES[rel]) return false;
      return !KEYS_SLOTS.test(readFileSync(join(SRC, rel), "utf8"));
    });
    expect(
      unclassified,
      "These files write focus_sessions.expected_outputs without keying the slots " +
        "(stampSlotKeys / carrySlotKeys / a door that calls them). Key them, or — " +
        "if the write only spreads stored slots — classify it in PRESERVES with why."
    ).toEqual([]);
  });

  it("no PRESERVES entry is stale", () => {
    expect(Object.keys(PRESERVES).filter((k) => !writers.includes(k))).toEqual(
      []
    );
  });
});
