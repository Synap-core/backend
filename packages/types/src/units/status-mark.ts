/**
 * THE MARK OF A STORED STATUS: its words, tone and glyph, read off the
 * machine's own declaration. A thing that ended wears HOW it ended
 * ({@link StatusOutcome}): a cancel stays calm, a held stop (a run that
 * changed nothing or reached its limit) and a session closed with required
 * work open are amber, only a fault is red. A run that has not ended wears
 * whose turn it is (`resolveRunUnitState`). Anything else wears its
 * category's tone ({@link resolveStatusTone}).
 *
 * For the pod's own machines. A value of a KIND's declared lifecycle is
 * app-bases `statusValueMark` (`@synap-core/headless/property-renderer`).
 */
import type { LifecycleCategory } from "../lifecycle/option.js";
import {
  categoryOf,
  statusesInCategories,
} from "../lifecycle/category-sets.js";
import {
  SESSION_STATUS_DECLARATION,
  sessionClosedAs,
} from "../focus-sessions/statuses.js";
import { resolveStatusLabel } from "../vocabulary/index.js";
import type { Locale } from "../i18n/locale.js";
import {
  resolveRunUnitState,
  resolveStatusTone,
  type UnitGlyph,
  type UnitState,
  type UnitTone,
} from "./state.js";
import { RUN_STATUS_DECLARATION } from "./run-status.js";
import { PROPOSAL_STATUS_DECLARATION } from "./proposal-status.js";
import { TRACK_STATUS_DECLARATION } from "./track-status.js";
import {
  AUTOMATION_RUN_STATUS_DECLARATION,
  AUTOMATION_STATUS_DECLARATION,
  CHAT_TURN_STATUS_DECLARATION,
  INSTALLATION_STATUS_DECLARATION,
  PLAYBOOK_STATUS_DECLARATION,
  STAGE_RUN_STATUS_DECLARATION,
} from "./machines.js";

/**
 * Every machine with a declaration, by the name a caller passes. `run` is a
 * run of any ledger (playbook, automation, chat turn) as the runs feed speaks
 * it: the ledgers agree on every shared word, and the feed says `paused` for
 * a paused or stale session.
 */
export const STATUS_MACHINES = {
  session: SESSION_STATUS_DECLARATION,
  run: {
    ...CHAT_TURN_STATUS_DECLARATION,
    ...AUTOMATION_RUN_STATUS_DECLARATION,
    ...RUN_STATUS_DECLARATION,
    paused: { category: "paused" },
  },
  automation: AUTOMATION_STATUS_DECLARATION,
  stage_run: STAGE_RUN_STATUS_DECLARATION,
  playbook: PLAYBOOK_STATUS_DECLARATION,
  installation: INSTALLATION_STATUS_DECLARATION,
  proposal: PROPOSAL_STATUS_DECLARATION,
  track: TRACK_STATUS_DECLARATION,
} as const;
export type StatusMachine = keyof typeof STATUS_MACHINES;

/**
 * The run words a run still going wears in the runs feed (what Cancel takes):
 * open, active and paused, but not `proposed` (it waits for its approved
 * start), the rule of `LIVE_RUN_STATUSES`. The feed's `paused` (a paused or
 * stale run) is one of them.
 */
export const LIVE_RUN_FEED_STATUSES: readonly string[] = statusesInCategories(
  STATUS_MACHINES.run,
  ["open", "active", "paused"]
).filter((s) => s !== "proposed");

/** How a thing that ended, ended. `null` while it has not ended. */
export const STATUS_OUTCOMES = [
  "done",
  "not_done",
  "no_effect",
  "failed",
  "cancelled",
] as const;
export type StatusOutcome = (typeof STATUS_OUTCOMES)[number];

/**
 * The glyph a mark wears: a unit-state glyph, or `moving` (in progress) and
 * `stopped` (it ended or stands without breaking). Each surface maps these
 * tokens to its own icon set, once.
 */
export type StatusGlyph = UnitGlyph | "moving" | "stopped";

/** What the row says beyond its status word. */
export interface StatusMarkFacts {
  /**
   * A run's `stop_reason`: `budget` (it reached a limit) and `no_effect` (its
   * turn changed nothing) need a look and are not faults; `stages_left` is.
   */
  stopReason?: string | null;
  /** A session's `verification_report.closedNotDone`: closed with required work open. */
  closedNotDone?: boolean | null;
  locale?: Locale;
}

export interface StatusMark {
  status: string;
  /** `null` for a word the machine does not declare: drawn muted, never guessed. */
  category: LifecycleCategory | null;
  outcome: StatusOutcome | null;
  label: string;
  tone: UnitTone;
  glyph: StatusGlyph;
  /**
   * A run that has not ended answers "whose turn is it" (`resolveRunUnitState`):
   * its tone and glyph are that state's, never the lifecycle table's. `null`
   * for every other mark.
   */
  turn: UnitState | null;
}

/** Words that stand as a fault while the thing has not ended, with their label word. */
const FAULT_WORDS: Partial<
  Record<StatusMachine, Readonly<Record<string, string>>>
> = {
  automation: { error: "stopped_on_error" },
  proposal: { approval_failed: "approval_failed" },
};

/** A run stopped by one of these reasons ended without a fault, with this label word. */
const HELD_STOPS: Readonly<Record<string, StatusOutcome>> = {
  budget: "not_done",
  no_effect: "no_effect",
};
const HELD_STOP_LABEL: Readonly<Record<string, string>> = {
  budget: "stopped_at_limit",
  no_effect: "no_effect",
};

const ENDED_GLYPH = {
  done: "check",
  not_done: "stopped",
  no_effect: "dashed-circle",
  failed: "alert",
  cancelled: "stopped",
} as const satisfies Record<StatusOutcome, StatusGlyph>;

const STANDING_GLYPH = {
  open: "clock",
  active: "moving",
  paused: "pause",
} as const satisfies Record<"open" | "active" | "paused", StatusGlyph>;

function outcomeOf(
  machine: StatusMachine,
  status: string,
  category: LifecycleCategory | null,
  facts: StatusMarkFacts
): StatusOutcome | null {
  if (FAULT_WORDS[machine]?.[status]) return "failed";
  if (category === "done") {
    if (machine === "session")
      return sessionClosedAs(status, facts.closedNotDone === true) ===
        "not_done"
        ? "not_done"
        : "done";
    // Its precondition was false: it ended with nothing to do, calmly.
    return status === "skipped" ? "cancelled" : "done";
  }
  if (category !== "lost") return null;
  const held = facts.stopReason ? HELD_STOPS[facts.stopReason] : undefined;
  if (held) return held;
  // Every other lost word (cancelled, archived, rejected, withdrawn,
  // expired, reverted, removed) ended without anything breaking.
  return status === "failed" ? "failed" : "cancelled";
}

function labelWordOf(
  machine: StatusMachine,
  word: string,
  outcome: StatusOutcome | null,
  facts: StatusMarkFacts
): string {
  const fault = FAULT_WORDS[machine]?.[word];
  if (fault) return fault;
  if (outcome === "not_done" && machine === "session") return "not_done";
  if (outcome === "no_effect" || outcome === "not_done")
    return HELD_STOP_LABEL[facts.stopReason ?? ""] ?? word;
  return word;
}

/** The one mark of `status` on `machine`; `null` when there is no status to show. */
export function statusMark(
  machine: StatusMachine,
  status: string | null | undefined,
  facts: StatusMarkFacts = {}
): StatusMark | null {
  const word = status?.trim();
  if (!word) return null;
  const category = categoryOf(STATUS_MACHINES[machine], word);
  const outcome = outcomeOf(machine, word, category, facts);
  const label = resolveStatusLabel(
    labelWordOf(machine, word, outcome, facts),
    facts.locale
  );
  if (machine === "run" && !outcome && category) {
    const view = resolveRunUnitState(word);
    return {
      status: word,
      category,
      outcome,
      label,
      tone: view.tone,
      glyph: view.glyph,
      turn: view.state,
    };
  }
  return {
    status: word,
    category,
    outcome,
    label,
    // A held stop needs a look and is not an error: `not_done`'s paused
    // tone (the write receipt's calm `no_effect` row stays as it is).
    tone: resolveStatusTone(
      outcome === "no_effect" ? "not_done" : (outcome ?? category)
    ),
    glyph: outcome
      ? ENDED_GLYPH[outcome]
      : category
        ? STANDING_GLYPH[category as keyof typeof STANDING_GLYPH]
        : "question",
    turn: null,
  };
}
