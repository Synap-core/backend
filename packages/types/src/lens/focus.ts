/**
 * FOCUS — the SAME session / track page, led by its state (U4, D2a).
 *
 * Focus is not a new screen. A session or track page keeps the ONE lens order
 * ({@link LENS_SECTION_ORDER}); its state only picks which present section
 * comes FIRST and which ONE action fills the header's primary slot. One rule,
 * so the phone and the browser cannot disagree about what a page leads with.
 *
 * ── It extends the lead rule, it does not fork it ──────────────────────────
 * `resolveWorkLead` (`../units/lead.ts`) already decides "owed outranks a grade
 * owed, which outranks the steps" for what Needs you / the spine put first.
 * This rule keeps that precedence verbatim at page level — `needs_you` leads
 * Needs you, else a grade owed leads Done means — before it reads any other
 * state. `focus.test.ts` holds the two equal over every state.
 *
 * ── The table (state → lead · primary) ─────────────────────────────────────
 *   needs_you    → blocking   · the ask's own verb (the header next move's)
 *   grade owed   → doneMeans (track: structure) · Accept · secondary Send back
 *   needs_review → blocking   · the ask's own verb — this unit state is PENDING
 *                  PROPOSALS (`resolveUnitState`), which the lens classes as
 *                  Blocking; a grade owed is `gradeOwed`, a separate read
 *   working      → happening  · Message (steer the agent from its room)
 *   blocked      → no lead    · Open the blocker (the door IS what it waits on)
 *   not_started  → earlierSteps (track: structure) · Start (a stage only)
 *   done         → produced (track: structure) · track: Move on, when offered
 *   failed       → no lead    · Open the failed run — the page's alert block
 *                  already precedes the lens at every state
 *   paused / scheduled / unmeasured / unknown → no lead · no primary: nothing
 *                  is the reader's to do (paused: the header says who holds
 *                  it), or nothing was measured to promote.
 *
 * ── Reordering never resurrects ────────────────────────────────────────────
 * {@link lensFocusOrder} moves the lead to the front ONLY of the sections the
 * host passes — the ones it draws. A lead the host omitted (Needs you with
 * nothing in it) changes nothing: the fixed order stands.
 */

import { resolveActionLabel } from "../vocabulary/index.js";
import type { TrackMoveOn } from "../units/track-step.js";
import { lensSections, type LensSection } from "./classes.js";
import type { LensNextMove } from "./header.js";
import type { LensDoor, LensVerb } from "./rows.js";

/** Focus covers the two unit-of-work pages. */
export type LensFocusScope = "session" | "track";

/**
 * The step sections a SESSION page draws in the lens's `structure` place —
 * after Produced: "Done means" (its criteria), then "From earlier steps".
 */
export const SESSION_STEP_SECTIONS = ["doneMeans", "earlierSteps"] as const;
export type SessionStepSection = (typeof SESSION_STEP_SECTIONS)[number];

/** Every section a focus page can lead with. */
export type LensSectionKey = LensSection | SessionStepSection;

export const SESSION_STEP_SECTION_LABELS = {
  doneMeans: "Done means",
  earlierSteps: "From earlier steps",
} as const satisfies Record<SessionStepSection, string>;

/**
 * The sections a focus page can draw, in the FIXED order. Track = the lens
 * (`structure` = the step rail + the selected step's card). Session = the lens
 * with its step sections in the `structure` place.
 */
export function lensFocusSections(scope: LensFocusScope): LensSectionKey[] {
  if (scope === "track") return lensSections("track");
  return lensSections("session").flatMap((s): LensSectionKey[] =>
    s === "produced" ? [s, ...SESSION_STEP_SECTIONS] : [s]
  );
}

/** What the primary action acts on. The host owns the act; this names it. */
export type LensFocusTarget =
  /** Open this object (the ask, the blocker, the failed run). */
  | { kind: "door"; door: LensDoor }
  /** The unit's criteria — Accept / Send back on the gradable rows. */
  | { kind: "grade" }
  /** The working session's room composer. */
  | { kind: "room" }
  /** Start this step. */
  | { kind: "start-step"; stageKey: string }
  /** `trackMoveOn` — `enabled: false` draws it disabled with `missing`. */
  | {
      kind: "move-on";
      next: { key: string; name: string };
      enabled: boolean;
      missing: string[];
    };

export interface LensFocusAction {
  verb: LensVerb;
  target: LensFocusTarget;
}

export interface LensFocus {
  /** The section that comes first; null ⇒ the fixed order stands. */
  lead: LensSectionKey | null;
  /** The header's ONE primary action; null ⇒ none. */
  primary: LensFocusAction | null;
  /** Only beside a grade: Send back. */
  secondary: LensFocusAction | null;
}

export interface LensFocusInput {
  scope: LensFocusScope;
  /**
   * `resolveUnitState(...).state` — on a TRACK, the SELECTED STEP's state.
   * An unknown string is treated as unhandled (no lead from it).
   */
  state: string | null | undefined;
  /**
   * A criterion awaits the reader's grade (`ScorecardView.needsYou` on a
   * readable scorecard). False for an unreadable one: a failed read asserts
   * no obligation — the same input `resolveWorkLead` takes.
   */
  gradeOwed?: boolean;
  /** The header's next move (`lensHeaderModel(...).nextMove`): the ask's verb + door. */
  nextMove?: LensNextMove | null;
  /** What a blocked unit waits on, as a door. */
  blockedBy?: LensDoor | null;
  /** The failed run, as a door. */
  failedRun?: LensDoor | null;
  /** The step this unit is (a stage session; the selected track step). */
  stageKey?: string | null;
  /** Track only: `trackMoveOn(...)` for the selected step. */
  moveOn?: TrackMoveOn | null;
}

function verb(action: string): LensVerb {
  return { action, label: resolveActionLabel(action, "imperative") };
}

function openDoor(door: LensDoor | null | undefined): LensFocusAction | null {
  return door ? { verb: verb("open"), target: { kind: "door", door } } : null;
}

/** The ask's OWN verb (Answer / Approve / Review), never a generic one. */
function askAction(
  next: LensNextMove | null | undefined
): LensFocusAction | null {
  if (!next || next.section !== "blocking" || !next.door) return null;
  return { verb: next.verb, target: { kind: "door", door: next.door } };
}

const NONE: LensFocus = { lead: null, primary: null, secondary: null };

export function lensFocus(input: LensFocusInput): LensFocus {
  const track = input.scope === "track";
  const state = input.state ?? null;

  // resolveWorkLead's precedence, verbatim: what you HOLD, then what you judge.
  if (state === "needs_you") {
    return {
      lead: "blocking",
      primary: askAction(input.nextMove),
      secondary: null,
    };
  }
  if (input.gradeOwed) {
    return {
      lead: track ? "structure" : "doneMeans",
      primary: { verb: verb("accept"), target: { kind: "grade" } },
      secondary: { verb: verb("send_back"), target: { kind: "grade" } },
    };
  }

  switch (state) {
    case "needs_review":
      return {
        lead: "blocking",
        primary: askAction(input.nextMove),
        secondary: null,
      };
    case "working":
      return {
        lead: "happening",
        primary: { verb: verb("message"), target: { kind: "room" } },
        secondary: null,
      };
    case "blocked":
      return {
        lead: null,
        primary: openDoor(input.blockedBy),
        secondary: null,
      };
    case "failed":
      return {
        lead: null,
        primary: openDoor(input.failedRun),
        secondary: null,
      };
    case "not_started":
      return {
        lead: track ? "structure" : "earlierSteps",
        primary: input.stageKey
          ? {
              verb: verb("start"),
              target: { kind: "start-step", stageKey: input.stageKey },
            }
          : null,
        secondary: null,
      };
    case "done": {
      if (!track) return { lead: "produced", primary: null, secondary: null };
      const m = input.moveOn;
      return {
        lead: "structure",
        primary:
          m && m.offered && m.next
            ? {
                verb: verb("move_on"),
                target: {
                  kind: "move-on",
                  next: { key: m.next.key, name: m.next.name },
                  enabled: m.enabled,
                  missing: m.missing,
                },
              }
            : null,
        secondary: null,
      };
    }
    default:
      // paused / scheduled / unmeasured / unknown: nothing to promote.
      return NONE;
  }
}

/**
 * The host's DRAWN sections with the lead first; the rest keep their order.
 * A lead the host did not pass (an omitted section) changes nothing.
 */
export function lensFocusOrder<K extends string>(
  sections: readonly K[],
  lead: LensSectionKey | null | undefined
): K[] {
  const first = sections.find((s) => s === lead);
  if (first === undefined) return [...sections];
  return [first, ...sections.filter((s) => s !== first)];
}
