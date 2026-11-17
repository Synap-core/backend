/**
 * TRIPWIRE — a door that rewrites a session's slots owes the slot transition
 * (reactions W1). A slot's status is DERIVED (`slotStatusOf`), so no column
 * write can owe it: the door that writes `expected_outputs` must call
 * `oweSlotTransitions` in the same transaction, with the slots it locked and
 * the slots it wrote. `updateExpectedOutputsLocked` (the shared locked write:
 * block, unblock, delegate, return, the decision-ask raise and retire, the
 * answer's decision filing) owes for every caller.
 *
 * DERIVED: every raw `.update(focusSessions).set({ … expectedOutputs … })`
 * under the api sources is found; each must have `oweSlotTransitions(` within
 * the next 1500 characters, or be CLASSIFIED below with the reason its write
 * can move no slot's derived status.
 *
 * WHAT IT DOES NOT SEE: a write whose `.set(` argument is a variable (the
 * update doors hand `set` to `writeSessionPatch`; `update-session.ts` owes
 * beside it), and the close door, whose retirement rides `setSessionStatus`'s
 * `set` (it owes after that call).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const ROOTS = ["packages/api/src", "packages/jobs/src", "apps/api/src"];

/** Writes that only add slots or stamp receipts: no slot's status moves. */
const CLASSIFIED: Record<string, string> = {
  "packages/api/src/services/focus-sessions/follow-playbook.ts":
    "merges the playbook's declared slots in: births, never a move",
  "packages/api/src/services/focus-sessions/stage-slots.ts":
    "adds the entered stage's slots: births, never a move",
  "packages/api/src/services/focus-sessions/subject-edge.ts":
    "stamps the subject-edge receipt on a slot already done",
  "packages/api/src/services/focus-sessions/answer-pickup.ts":
    "stamps that the agent picked the answer up; the slot stays answered",
  "packages/api/src/services/focus-sessions/ask-later.ts":
    "defers an owed ask; it stays owed",
};

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Each raw slot write in `src`: its offset, and whether it owes after. */
function slotWrites(src: string): Array<{ at: number; owes: boolean }> {
  const out: Array<{ at: number; owes: boolean }> = [];
  for (const m of src.matchAll(/\.update\(\s*focusSessions\s*\)\s*\.set\(/g)) {
    const rest = src.slice(m.index! + m[0].length);
    const end = rest.search(/\.where\(|\.returning\(/);
    const arg = end === -1 ? rest.slice(0, 300) : rest.slice(0, end);
    if (!/\bexpectedOutputs\b/.test(arg)) continue;
    out.push({
      at: m.index!,
      owes: src
        .slice(m.index!, m.index! + 1500)
        .includes("oweSlotTransitions("),
    });
  }
  return out;
}

function scan() {
  const found: Array<{ file: string; owes: boolean }> = [];
  for (const root of ROOTS) {
    for (const file of walk(join(BACKEND_ROOT, root))) {
      const src = stripComments(readFileSync(file, "utf8"), "ts");
      for (const w of slotWrites(src)) {
        found.push({
          file: relative(BACKEND_ROOT, file).split("\\").join("/"),
          owes: w.owes,
        });
      }
    }
  }
  return found;
}

describe("a door that rewrites slots owes their transitions", () => {
  it("SELF-GUARD: sees a slot write, and whether it owes", () => {
    expect(
      slotWrites(`await tx.update(focusSessions).set({ expectedOutputs: next })
        .where(eq(focusSessions.id, id));
        await oweSlotTransitions(tx, { sessionId: id, before, after: next });`).map(
        (w) => w.owes
      )
    ).toEqual([true]);
    expect(
      slotWrites(`await tx.update(focusSessions).set({ metadata })
        .where(eq(focusSessions.id, id));`)
    ).toEqual([]);
  });

  it("is not vacuous: it sees the known doors", () => {
    const files = scan().map((f) => f.file);
    for (const known of [
      "packages/api/src/services/focus-sessions/answer-slot.ts",
      "packages/api/src/services/focus-sessions/satisfy-expected-output.ts",
      "packages/api/src/services/focus-sessions/delegate-output.ts",
    ]) {
      expect(files).toContain(known);
    }
  });

  it("every raw slot write owes, or is classified", () => {
    const offenders = scan()
      .filter((w) => !w.owes && !(w.file in CLASSIFIED))
      .map((w) => w.file);
    expect(
      offenders,
      "These rewrite focus_sessions.expected_outputs without owing the slot " +
        "transition. Call oweSlotTransitions(tx, { sessionId, before, after, " +
        "actor }) in the same transaction (@synap/database), or classify the " +
        "write here with the reason no slot's status can move."
    ).toEqual([]);
  });

  it("every classified file still writes slots (no stale entries)", () => {
    const files = new Set(scan().map((w) => w.file));
    for (const file of Object.keys(CLASSIFIED)) {
      expect(files, `${file} no longer writes slots`).toContain(file);
    }
  });
});
