/**
 * WHERE ITS WORK STANDS — the pure model behind the work section of a
 * session page and a thing page (`views/work-section.tsx`). It reads ONE
 * answer, `lifecycle.statusOf({ include: ["work"] })` (`StatusOfWork`,
 * `@synap-core/types/units`), and decides only what to draw: nothing is
 * re-derived from the session row, the stage list, the gates or the next move
 * are the pod's.
 *
 *   - an item with nothing to say (no stages, no stop, no gate waiting, no
 *     ask, no hold) is left out, and a section with no item is OMITTED;
 *   - a stopped run leads: "Stopped at Script", with Continue only when the
 *     read says THIS reader may (`continue.canAct`, the door's own check);
 *   - a gate waiting on a person is always said; Approve / Send back only
 *     when the read says this reader may decide it (`canReview`, the
 *     verdict the review list and the approve door share);
 *   - the gates come first; Continue is the loud button only when nothing
 *     else waits on the reader (`continueEmphasis`);
 *   - the next move is the pod's line, as the pod words it (a run that
 *     ended early reads its `stopped_early` move, never "Nothing waiting");
 *   - a part that could not be read is its own state, never "nothing".
 */
import type {
  StatusOfWork,
  StatusOfWorkContinue,
  StatusOfWorkGate,
  StatusOfWorkItem,
  StatusOfWorkStagePosition,
} from "@synap-core/types/units";
import type { RecordedHold } from "@synap-core/types/lifecycle";
import { humanizeToken } from "@synap-core/types/vocabulary";

/** The work part as a door returns it: the answer, or a failed read. */
export type WorkRead = StatusOfWork | { status: "unavailable" } | undefined;

/** One stage as the stepper draws it. */
export interface WorkStageMark {
  key: string;
  name: string;
  position: StatusOfWorkStagePosition;
  /** The stage's gate, when it declares one. */
  gate: StatusOfWorkGate | null;
  /** The run stopped on this stage: drawn stopped, never "current". */
  stoppedHere: boolean;
}

/** The stages, each with its gate; `null` when they could not be read. */
export function workStages(item: StatusOfWorkItem): WorkStageMark[] | null {
  if (item.stages.status !== "ok") return null;
  const gates =
    item.gates.status === "ok"
      ? new Map(item.gates.items.map((g) => [g.stageKey, g]))
      : new Map<string, StatusOfWorkGate>();
  const stoppedAt = item.stopped?.at?.key ?? null;
  return item.stages.items.map((s) => ({
    key: s.key,
    name: s.name,
    position: s.position,
    gate: gates.get(s.key) ?? null,
    stoppedHere: s.key === stoppedAt,
  }));
}

/** The gates a person decides now: pending, with the proposal that decides it. */
export function gatesWaiting(
  item: StatusOfWorkItem
): Array<StatusOfWorkGate & { proposalId: string }> {
  if (item.gates.status !== "ok") return [];
  return item.gates.items.filter(
    (g): g is StatusOfWorkGate & { proposalId: string } =>
      g.state === "pending" && !!g.proposalId && g.kind !== "check"
  );
}

/** The Continue button, only when this reader may continue it now. */
export function continueButton(
  item: StatusOfWorkItem
): StatusOfWorkContinue | null {
  return item.continue?.canAct ? item.continue : null;
}

/**
 * How loud Continue is: `solid` only when it is the reader's one move left;
 * `flat` while a gate they may decide or an ask still waits on them (those
 * come first, then the run goes on).
 */
export function continueEmphasis(item: StatusOfWorkItem): "solid" | "flat" {
  const gateWaits = gatesWaiting(item).some((g) => g.canReview);
  return gateWaits || (asksOwed(item) ?? 0) > 0 ? "flat" : "solid";
}

/** What a gate card says after the reader decided it. */
export type GateDecided = "approved" | "sent_back";

/**
 * The card's state after a decision event. The review's decision path calls
 * `rejected` and THEN its common `decided`: a Send back stays "sent back".
 */
export function afterGateDecision(
  prev: GateDecided | null,
  event: "decided" | "rejected"
): GateDecided {
  return event === "rejected" ? "sent_back" : (prev ?? "approved");
}

/** The items of a work read; none when it is absent or failed. */
export function workItems(read: WorkRead): StatusOfWorkItem[] {
  return read && !("status" in read) ? read.items : [];
}

/** Does the read offer THIS reader a Continue on any of its items? */
export function offersContinue(read: WorkRead): boolean {
  return workItems(read).some((i) => continueButton(i) !== null);
}

/** The gate proposals the work section draws as cards (pending, waiting on a person). */
export function gateProposalIds(read: WorkRead): Set<string> {
  return new Set(
    workItems(read).flatMap((i) => gatesWaiting(i).map((g) => g.proposalId))
  );
}

/** How many asks it owes the person; `null` when that could not be read. */
export function asksOwed(item: StatusOfWorkItem): number | null {
  return item.asks.status === "ok" ? item.asks.total : null;
}

/** Its current hold, when it stands paused under one it could read. */
export function workHold(item: StatusOfWorkItem): RecordedHold | null {
  const h = item.hold;
  return h && "on" in h ? h : null;
}

/** "On hold: waiting on a person, the brief", in the person's words. */
export function holdLine(hold: RecordedHold): string {
  const on =
    hold.on === "unspecified" || hold.on === "nobody"
      ? null
      : humanizeToken(hold.on).toLowerCase();
  const why = hold.reason?.trim();
  return ["On hold", on ? `waiting on ${on}` : null, why || null]
    .filter(Boolean)
    .join(" · ");
}

/** Does this item have anything to say on a page? */
export function hasWorkToShow(item: StatusOfWorkItem): boolean {
  const stages = workStages(item);
  return (
    (stages !== null && stages.length > 0) ||
    item.stopped !== null ||
    gatesWaiting(item).length > 0 ||
    (asksOwed(item) ?? 0) > 0 ||
    workHold(item) !== null ||
    // A failed part is said, never hidden.
    item.stages.status === "unavailable"
  );
}

/**
 * The next move's line, the pod's own (a run that ended early is the pod's
 * `stopped_early` move); `null` when the pod says nothing waits.
 */
export function nextMoveLine(item: StatusOfWorkItem): {
  label: string;
  reason: string | null;
  yours: boolean;
} | null {
  const m = item.nextMove;
  if (m.kind === "none") return null;
  return {
    label: m.label,
    reason: m.reason || null,
    yours: m.actor === "user",
  };
}

/** "2 stages left: Draft, Publish". */
export function stagesLeftLine(item: StatusOfWorkItem): string | null {
  const left = item.stopped?.left ?? [];
  if (left.length === 0) return null;
  return `${left.length} stage${left.length === 1 ? "" : "s"} left: ${left
    .map((s) => s.name)
    .join(", ")}`;
}

/**
 * What the section draws: the items with something to say, the stopped ones
 * first (attention first), or the failed read.
 */
export function workToShow(
  read: WorkRead
):
  | { kind: "failed" }
  | { kind: "none" }
  | { kind: "items"; items: StatusOfWorkItem[]; truncated: boolean } {
  if (!read) return { kind: "none" };
  if ("status" in read) return { kind: "failed" };
  const items = read.items.filter(hasWorkToShow);
  if (items.length === 0) return { kind: "none" };
  const stoppedFirst = [
    ...items.filter((i) => i.stopped),
    ...items.filter((i) => !i.stopped),
  ];
  return { kind: "items", items: stoppedFirst, truncated: read.truncated };
}
