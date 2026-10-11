import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";

/**
 * RATCHET — the advances that still write `focus_sessions.current_stage`
 * DIRECTLY instead of letting the subject's status lead (STEP = STATUS, work
 * model L5, 2026-10-12; `services/focus-sessions/advance-stage.ts` header).
 *
 * Since 5a1deeb1 an ungated `"door"` advance into a subject-led stage moves the
 * subject through the status door and process-sync's follow writes the column.
 * Two kinds of advance still write it themselves, and this pins how many:
 *
 *   1. CALLER doors — every call of the one door with `stageWrite: "caller"`:
 *      they wrote the column in their own multi-field UPDATE (the outputs-lock
 *      TOCTOU is why they were not converted in wave 3).
 *   2. The GATED path — `moveSubjectFirst` declines a gated stage, so it keeps
 *      "the stage stands, the gate pauses" (`stage-gate.ts`).
 *
 * SHRINK-ONLY. Both sets are DERIVED by scanning the source, never listed. A
 * new caller door or a new gated decline turns this red; retiring one turns it
 * red too, with a message to lower the ceiling — so the number only goes down.
 * WAVE 5 retires all of them: the gate executor and the routers, together with
 * L7's track-stage retirement.
 *
 * What it does NOT see (stated, not implied): a raw `UPDATE … current_stage`
 * outside the door (`current-stage-one-door.test.ts` guards the set of writer
 * FILES), and the door's other direct-write fallbacks that are not debt — a
 * subject already holding the value (no event would follow), a failed subject
 * write, a kind with no declared lifecycle. Those are named in the door's
 * header, not counted here.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = join(HERE, "..");
const JOBS_SRC = join(HERE, "..", "..", "..", "jobs", "src");
const DOOR = join(API_SRC, "services/focus-sessions/advance-stage.ts");

/** Lower these when a writer is retired; never raise them. */
const CALLER_DOOR_CEILING = 3;
const GATED_DECLINE_CEILING = 1;

function tsFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, acc);
    else if (
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".d.ts") &&
      !e.name.endsWith(".test.ts") &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    )
      acc.push(p);
  }
  return acc;
}

/** A CALL passing `stageWrite: "caller"` — not a type, not a comment. */
const CALLER_CALL = /^\s*stageWrite:\s*"caller",?\s*$/;

function callerDoorSites(): string[] {
  const out: string[] = [];
  for (const [prefix, root] of [
    ["api", API_SRC],
    ["jobs", JOBS_SRC],
  ] as const) {
    for (const file of tsFiles(root)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes('"caller"')) continue;
      src.split("\n").forEach((l, i) => {
        if (CALLER_CALL.test(l))
          out.push(`${prefix}:${relative(root, file)}:${i + 1}`);
      });
    }
  }
  return out.sort();
}

/** The body of `moveSubjectFirst`, up to the next top-level declaration. */
function moveSubjectFirstBody(): string {
  const src = readFileSync(DOOR, "utf8");
  const at = src.indexOf("async function moveSubjectFirst(");
  expect(at, "moveSubjectFirst not found in advance-stage.ts").toBeGreaterThan(
    -1
  );
  const rest = src.slice(at);
  const end = rest.indexOf("\n}\n");
  expect(end).toBeGreaterThan(0);
  return rest.slice(0, end);
}

describe("ratchet: direct current_stage writers that bypass step = status", () => {
  it("NON-VACUITY: the scan walks both packages and its patterns still match", () => {
    expect(tsFiles(API_SRC).length).toBeGreaterThan(200);
    expect(tsFiles(JOBS_SRC).length).toBeGreaterThan(50);
    expect(CALLER_CALL.test('        stageWrite: "caller",')).toBe(true);
    expect(CALLER_CALL.test('  stageWrite: "caller" | "door";')).toBe(false);
    expect(CALLER_CALL.test(' *   "caller" — the stage column')).toBe(false);
    expect(moveSubjectFirstBody()).toContain("writeStageSubjectStatus(");
  });

  it(`caller doors: exactly ${CALLER_DOOR_CEILING} (shrink-only)`, () => {
    const sites = callerDoorSites();
    expect(
      sites.length,
      sites.length < CALLER_DOOR_CEILING
        ? `A caller door was retired — lower CALLER_DOOR_CEILING to ${sites.length}.`
        : `A NEW direct current_stage writer: ${sites.join(", ")}. Use stageWrite "door" (the subject leads) instead.`
    ).toBe(CALLER_DOOR_CEILING);
  });

  it(`gated declines in the door: exactly ${GATED_DECLINE_CEILING} (shrink-only)`, () => {
    const n = (moveSubjectFirstBody().match(/resolveStageGate\(/g) ?? [])
      .length;
    expect(
      n,
      n < GATED_DECLINE_CEILING
        ? "The gated path now lets the subject lead — lower GATED_DECLINE_CEILING."
        : "A new gated decline in moveSubjectFirst — that is a new direct writer."
    ).toBe(GATED_DECLINE_CEILING);
  });
});
