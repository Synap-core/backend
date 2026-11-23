/**
 * THE MARK OF A STORED STATUS: its word, its category and its tone, read off
 * the machine's own declaration. The tone is the one status tone table's
 * ({@link resolveStatusTone}) for its category, or for a thing that ended,
 * for HOW it ended ({@link StatusOutcome}), so a cancel stays calm, a turn that changed
 * nothing is not drawn as a crash, and a session closed with required work
 * open is not drawn as delivered. A paused status (a run nobody picked up, a
 * rule holding it, the person's turn) is a hold, never an error.
 */
import type { LifecycleCategory } from "../lifecycle/option.js";
import { categoryOf } from "../lifecycle/category-sets.js";
import {
  SESSION_STATUS_DECLARATION,
  sessionClosedAs,
} from "../focus-sessions/statuses.js";
import { resolveStatusLabel } from "../vocabulary/index.js";
import type { Locale } from "../i18n/locale.js";
import { resolveStatusTone, type UnitTone } from "./state.js";
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

/** How a thing that ended, ended. `null` while it has not ended. */
export const STATUS_OUTCOMES = [
  "done",
  "not_done",
  "no_effect",
  "failed",
  "cancelled",
] as const;
export type StatusOutcome = (typeof STATUS_OUTCOMES)[number];

/** What the row says beyond its status word. */
export interface StatusMarkFacts {
  /** A run's `stop_reason`: `no_effect` = its turn ended with nothing written. */
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
}

function outcomeOf(
  machine: StatusMachine,
  status: string,
  category: LifecycleCategory | null,
  facts: StatusMarkFacts
): StatusOutcome | null {
  if (category === "done") {
    if (machine === "session")
      return sessionClosedAs(status, facts.closedNotDone === true) ===
        "not_done"
        ? "not_done"
        : "done";
    // Its precondition was false: it ended with nothing to do.
    return status === "skipped" ? "no_effect" : "done";
  }
  if (category !== "lost") return null;
  if (facts.stopReason === "no_effect") return "no_effect";
  // Every other lost word (cancelled, archived, rejected, withdrawn,
  // expired, reverted, removed) ended without anything breaking.
  return status === "failed" ? "failed" : "cancelled";
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
  const labelWord =
    outcome === "not_done" ||
    (outcome === "no_effect" && facts.stopReason === "no_effect")
      ? outcome
      : word;
  // A run that ended changing nothing needs a look and is not an error: the
  // paused tone (the write receipt's calm `no_effect` row stays as it is). A
  // precondition skip keeps its own word's tone.
  const toneWord =
    outcome === "no_effect"
      ? facts.stopReason === "no_effect"
        ? "paused"
        : word
      : (outcome ?? category);
  return {
    status: word,
    category,
    outcome,
    label: resolveStatusLabel(labelWord, facts.locale),
    tone: resolveStatusTone(toneWord),
  };
}
