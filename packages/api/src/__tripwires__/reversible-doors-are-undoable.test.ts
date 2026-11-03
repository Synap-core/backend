/**
 * TRIPWIRE — "reversible" means undoable.
 *
 * The pod has two meanings of "reversible", and they used to disagree.
 * Governance (`REVERSIBILITY_DOOR_CLASS`, @synap/governance-policy) calls a
 * door `reversible` and, under the pod default `@reversible` (migration
 * 0282), lets an agent's write through it APPLY without asking, on the promise
 * that the person can undo it. The Undo planner (`wouldBeRevertable`,
 * routers/proposals/revert.ts) is what decides whether that undo exists. The
 * document doors were classed reversible ("version history restores it")
 * while the planner could not undo a single document edit, so every one read
 * "Can't be undone".
 *
 * For EVERY door the class table calls `reversible` (derived from the table,
 * so a new reversible door joins the scan by existing), a representative
 * pending proposal of that door — `targetType` = the subject, `proposalType`
 * = the action, the shape the gate files — must be predicted revertable, OR
 * the door must be in `NOT_YET_UNDOABLE` below with one line of why.
 *
 * `NOT_YET_UNDOABLE` is a RATCHET that may only SHRINK:
 *   - a door listed there that the planner CAN undo now fails the suite (take
 *     it off the list: the gap closed);
 *   - a door listed there that is no longer `reversible` fails it too;
 *   - the list may not grow past `NOT_YET_UNDOABLE_CEILING`. A new reversible
 *     door that Undo cannot undo is a defect to fix (give it an undo record),
 *     or a door to reclassify `disruptive` — not a line to add here.
 *
 * WHAT IT DOES NOT COVER, stated:
 *   - it asks the PENDING prediction with a near-empty payload (one fixture
 *     for a door whose prediction reads the payload, `REPRESENTATIVE_DATA`).
 *     A door whose undo only exists for some payloads passes on the
 *     representative one; the per-payload rules are the planner's own tests
 *     (`revert.*.test.ts`, `revertable-for-row.test.ts`);
 *   - it proves the planner OFFERS an undo, not that the undo restores the
 *     right thing (that is each door's undo test, e.g. the document edit
 *     PGlite suite) nor that the executor stamps the record the planner reads
 *     on an applied row;
 *   - the auto-approved receipt (`<subject>.<action>`) is not asked: its
 *     answer reads the stamp its door writes after the write.
 */
import { describe, it, expect } from "vitest";
import { REVERSIBILITY_DOOR_CLASS } from "@synap/governance-policy";
import { wouldBeRevertable } from "../routers/proposals/revert.js";

/**
 * Reversible doors the Undo planner cannot undo yet — may only shrink. Found
 * by this guard's first run (2026-11-03); none reclassified or fixed here.
 * "No undo record" = nothing the write stamps names what it changed, so the
 * planner has no inverse (`unsupported`). "Receipt only" = the auto-approved
 * receipt IS stamped and undoable once applied, but a PENDING proposal of the
 * door is not predicted revertable (`wouldBeRevertable` has no case for it).
 */
const NOT_YET_UNDOABLE: Readonly<Record<string, string>> = {
  "artifact/create":
    "No undo record: an artifact create stamps no created-rows record.",
  "artifact/setState":
    "No undo record: the previous artifact state is not recorded.",
  "bento/arrange": "No undo record: the previous layout is not recorded.",
  "cell/update": "No undo record: a cell config patch records no before/after.",
  "context/link":
    "No undo record: the link written is not recorded on the proposal.",
  "entity/renderer.set":
    "No undo record: the previous renderer is not recorded.",
  "entity/transition":
    "Undoable once applied (moved back through the status door); a PENDING move is predicted not revertable on purpose, so a person reads it (founder B3e).",
  "facet/attach":
    "No undo record: the attached facet is not recorded for the planner.",
  "facet/detach": "No undo record: the planner has no re-attach inverse.",
  "facet/update": "No undo record: a facet update records no before/after.",
  "focus_session/create":
    "No undo record the planner reads: a started session is not retired by Undo.",
  "knowledgeKey/create": "No undo record: the runbook created is not recorded.",
  "link/create":
    "Receipt only: `POST /links` stamps the receipt's linkIds, but a pending link create is not predicted revertable.",
  "playbook_run/update":
    "No undo record: run orchestration changes are not recorded.",
  "relation/create":
    "Receipt only: the relations door stamps the receipt's relationIds, but a pending relation create is not predicted revertable.",
  "relation/update":
    "No undo record: a relation update records no before/after.",
  "track/update":
    "No undo record: a goal's advance / params / status change records no before/after.",
  "view/create":
    "No undo record: the view created is not recorded for the planner.",
  "view/update": "No undo record: a view update records no before/after.",
  "view/updateContent":
    "No undo record: the previous view content is not recorded.",
  "whiteboard/place": "No undo record: the placement is not recorded.",
};

/** The list may not grow past this. Lower it when you remove a line. */
const NOT_YET_UNDOABLE_CEILING = 21;

/**
 * A door whose prediction reads the payload gets a typical one; every other
 * door is asked with `{}`. A fixture, never the door set.
 */
const REPRESENTATIVE_DATA: Readonly<Record<string, unknown>> = {
  // Only a patch of the undoable columns is stamped (`session-undo.ts`).
  "focus_session/update": { data: { title: "Renamed" } },
  // A document patch carries its ops.
  "document/update": {
    data: { ops: [{ op: "replace_text", old: "a", new: "b" }] },
  },
  "document/section_update": {
    data: { ops: [{ op: "upsert_section", id: "s", title: "S", body: "x" }] },
  },
};

const REVERSIBLE_DOORS = (
  Object.keys(REVERSIBILITY_DOOR_CLASS) as Array<
    keyof typeof REVERSIBILITY_DOOR_CLASS
  >
)
  .filter((door) => REVERSIBILITY_DOOR_CLASS[door] === "reversible")
  .sort();

function undoable(door: string): boolean {
  const slash = door.indexOf("/");
  return wouldBeRevertable({
    targetType: door.slice(0, slash),
    targetId: "00000000-0000-4000-8000-000000000001",
    proposalType: door.slice(slash + 1),
    data: REPRESENTATIVE_DATA[door] ?? {},
  });
}

describe("every reversible door can be undone", () => {
  it("non-vacuity: the scan sees the reversible doors, and a known pair on each side", () => {
    expect(REVERSIBLE_DOORS.length).toBeGreaterThanOrEqual(25);
    // The precedent and the doors this guard was written for: undoable.
    expect(undoable("entity/update")).toBe(true);
    expect(undoable("document/section_update")).toBe(true);
    // A disruptive door is not scanned, and the planner cannot undo it.
    expect(REVERSIBLE_DOORS).not.toContain("entity/delete");
  });

  it("a reversible door is undoable, or listed with why", () => {
    const missing = REVERSIBLE_DOORS.filter(
      (door) => !undoable(door) && !(door in NOT_YET_UNDOABLE)
    );
    expect(
      missing,
      "These doors are classed `reversible` (an agent's write applies without asking, on the promise it can be undone) but the Undo planner cannot undo them. Give the write an undo record the planner reads, or classify the door `disruptive` — do not add it to NOT_YET_UNDOABLE."
    ).toEqual([]);
  });

  it("the exception list only shrinks: every line is still reversible, still not undoable, and under the ceiling", () => {
    const stale = Object.keys(NOT_YET_UNDOABLE).filter(
      (door) => !(REVERSIBLE_DOORS as string[]).includes(door) || undoable(door)
    );
    expect(
      stale,
      "These lines no longer describe a gap (the door is undoable now, or no longer reversible): remove them and lower NOT_YET_UNDOABLE_CEILING."
    ).toEqual([]);
    expect(Object.keys(NOT_YET_UNDOABLE).length).toBeLessThanOrEqual(
      NOT_YET_UNDOABLE_CEILING
    );
    for (const [door, why] of Object.entries(NOT_YET_UNDOABLE)) {
      expect(
        why.trim().length,
        `${door} needs one line of why`
      ).toBeGreaterThan(10);
    }
  });
});
