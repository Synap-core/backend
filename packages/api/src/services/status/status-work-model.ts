/**
 * WHERE ITS WORK STANDS, one item — PURE. The `include: ["work"]` part of
 * `statusOf` (`status-work.ts` reads; this shapes) for ONE session: its row,
 * its continuation packet and its newest playbook run, projected onto the
 * wire shape (`StatusOfWorkItem`, `@synap-core/types/units`).
 *
 * It RE-DERIVES NOTHING the packet already says. Gates, owed asks, pending
 * proposals, holder, liveness, last completion and the next move are the
 * packet's sections, renamed for the wire; a section the packet could not
 * read stays `unavailable` with its reason. What is composed here, and only
 * here:
 *   - the stage list: the session's declared stages (its own `stages`
 *     snapshot), placed done / current / left around `current_stage` (the
 *     `stagesLeft` reading), each with its newest entry of the packet's
 *     `stageRuns`. A run that FINISHED (no stage left, ended) reads every
 *     stage done;
 *   - the stop: `stoppedEarly` (`continue-run.ts`), the predicate the next
 *     move's `stopped_early` rung and the Continue door share;
 *   - the Continue offer: `continueAt`, THE door's own predicate, so the
 *     button is offered exactly when the door would run.
 */
import type {
  LifecycleCategory,
  RecordedHold,
} from "@synap-core/types/lifecycle";
import {
  resolveStatusTone,
  type StatusOfWorkAsk,
  type StatusOfWorkItem,
  type StatusOfWorkRun,
  type StatusOfWorkStage,
  type StatusOfWorkUnavailable,
} from "@synap-core/types/units";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { sessionStatusCategory } from "@synap-core/types/focus-sessions";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import type { ContinuationPacket } from "../focus-sessions/continuation-packet.js";
import {
  continueAt,
  continueLabel,
  stoppedEarly,
  type ContinueFacts,
} from "../focus-sessions/continue-run.js";
import { stageRefs, stoppedWhere } from "../runs/stages-left.js";
import { runStatusCategory } from "./status-facts.js";

/** Owed asks and pending proposals listed per item (totals stay exact). */
export const WORK_ITEM_LIST_MAX = 5;

/** The session columns an item reads. */
export interface WorkSessionRow {
  id: string;
  title: string | null;
  goal: string | null;
  status: string;
  playbookId: string | null;
  channelId: string | null;
  stages: unknown;
  currentStage: string | null;
  closedAt: Date | string | null;
}

/** The newest playbook run of the session, as read. */
export interface WorkRunRow {
  id: string;
  status: string;
  stopReason: string | null;
  error: string | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

const unavailable = (reason: string): StatusOfWorkUnavailable => ({
  status: "unavailable",
  reason,
});

function runOf(run: WorkRunRow): StatusOfWorkRun {
  return {
    id: run.id,
    status: run.status,
    label: resolveStatusLabel(run.status),
    category: runStatusCategory(run.status),
    stopReason: run.stopReason ?? null,
    error: run.error ?? null,
    startedAt: iso(run.startedAt)!,
    completedAt: iso(run.completedAt),
  };
}

/**
 * The declared stages, placed around the stage the run stands on, each with
 * its newest ledger entry. `finished` = the run is over with no stage left:
 * every stage reads done.
 */
export function workStages(input: {
  stages: unknown;
  currentStage: string | null;
  stageRuns: ContinuationPacket["stageRuns"];
  finished: boolean;
}):
  | { status: "ok"; items: StatusOfWorkStage[]; current: string | null }
  | StatusOfWorkUnavailable {
  if (input.stageRuns.status === "unavailable") {
    return unavailable(input.stageRuns.reason);
  }
  const declared = stageRefs(input.stages);
  const at = input.currentStage
    ? declared.findIndex((s) => s.key === input.currentStage)
    : -1;
  // Oldest first in the packet: the last entry of a key is its newest.
  const newest = new Map(input.stageRuns.items.map((e) => [e.stageKey, e]));
  return {
    status: "ok",
    current: at >= 0 ? declared[at]!.key : null,
    items: declared.map((s, i) => {
      const e = newest.get(s.key);
      return {
        key: s.key,
        name: s.name,
        position: input.finished
          ? "done"
          : i < at
            ? "done"
            : i === at
              ? "current"
              : "left",
        entry: e
          ? {
              status: e.status,
              attempt: e.attempt,
              startedAt: e.startedAt,
              endedAt: e.endedAt,
              agentName: e.agent?.name ?? null,
            }
          : null,
      };
    }),
  };
}

function asksOf(
  owed: ContinuationPacket["userMustDecide"]["owedSlots"]
): StatusOfWorkItem["asks"] {
  if (owed.status === "unavailable") return unavailable(owed.reason);
  return {
    status: "ok",
    total: owed.total,
    items: owed.items
      .slice(0, WORK_ITEM_LIST_MAX)
      .map((s): StatusOfWorkAsk => ({
        label: s.label,
        kind: s.kind,
        noun: s.noun,
        ...(s.why ? { why: s.why } : {}),
        ...(s.blockedReason ? { blockedReason: s.blockedReason } : {}),
        ...(s.owedSince ? { owedSince: s.owedSince } : {}),
        ...(s.criterionKey ? { criterionKey: s.criterionKey } : {}),
        ...(s.ask?.mode ? { askMode: s.ask.mode } : {}),
      })),
  };
}

/**
 * ONE work item. `packet` is the session's continuation packet, or the reason
 * it could not be built (every packet section is then `unavailable`, and the
 * next move unknown). `run` is its newest run (`null` = none), or the reason
 * the run read failed.
 */
export function workItemOf(input: {
  row: WorkSessionRow;
  on: StatusOfWorkItem["on"];
  kind: string;
  packet: ContinuationPacket | { failed: string };
  run: WorkRunRow | null | { failed: string };
  /** Its current hold, read only when it stands paused. */
  hold?: RecordedHold | StatusOfWorkUnavailable;
  link: string;
}): StatusOfWorkItem {
  const { row } = input;
  const category: LifecycleCategory | null = sessionStatusCategory(row.status);
  const runRead = input.run;
  const run =
    runRead && "failed" in runRead ? null : (runRead as WorkRunRow | null);
  const runKnown = !(runRead && "failed" in runRead);
  const facts: ContinueFacts = {
    status: row.status,
    playbookId: row.playbookId,
    stages: row.stages,
    currentStage: row.currentStage,
    runStatus: run?.status ?? null,
  };
  const stop = runKnown ? stoppedEarly(facts) : null;
  const again = runKnown && row.channelId ? continueAt(facts) : null;
  const finished =
    !stop &&
    !!row.playbookId &&
    (run?.status === "completed" || row.status === "closed");

  const packet = "failed" in input.packet ? null : input.packet;
  const failed = "failed" in input.packet ? input.packet.failed : "";
  const section = <T>(
    pick: (p: ContinuationPacket) => T
  ): T | StatusOfWorkUnavailable =>
    packet ? pick(packet) : unavailable(failed);

  return {
    sessionId: row.id,
    name: resolveSessionTitle(row) || null,
    kind: input.kind,
    status: row.status,
    label: resolveStatusLabel(row.status),
    category,
    tone: resolveStatusTone(row.status),
    on: input.on,
    playbookId: row.playbookId,
    run:
      runRead && "failed" in runRead
        ? unavailable(runRead.failed)
        : run
          ? runOf(run)
          : null,
    stages: packet
      ? workStages({
          stages: row.stages,
          currentStage: row.currentStage,
          stageRuns: packet.stageRuns,
          finished,
        })
      : unavailable(failed),
    gates: section((p) =>
      p.gates.status === "unavailable"
        ? unavailable(p.gates.reason)
        : {
            status: "ok" as const,
            items: p.gates.items.map((g) => ({
              stageKey: g.stageKey,
              stageName: g.stageName,
              kind: g.kind,
              state: g.state,
              ...(g.proposalId ? { proposalId: g.proposalId } : {}),
              decidedByHuman: g.decidedByHuman,
              ...(g.decidedAt ? { decidedAt: g.decidedAt } : {}),
            })),
          }
    ),
    asks: section((p) => asksOf(p.userMustDecide.owedSlots)),
    proposals: section((p) => {
      const pending = p.userMustDecide.pendingProposals;
      return pending.status === "unavailable"
        ? unavailable(pending.reason)
        : {
            status: "ok" as const,
            total: pending.total,
            items: pending.items.slice(0, WORK_ITEM_LIST_MAX).map((x) => ({
              id: x.id,
              title: x.title,
              proposalType: x.proposalType,
            })),
          };
    }),
    ...(category === "paused" && input.hold ? { hold: input.hold } : {}),
    holder: section((p) =>
      p.holder.status === "unavailable"
        ? unavailable(p.holder.reason)
        : {
            kind: p.holder.holder.kind,
            waitKind: p.holder.holder.waitKind,
            since: p.holder.holder.since,
            agentName:
              p.holder.holder.agent?.displayName ??
              p.holder.holder.agent?.name ??
              null,
            ...(p.holder.holder.reason
              ? { reason: p.holder.holder.reason }
              : {}),
          }
    ),
    live: section((p) =>
      p.live.status === "unavailable"
        ? unavailable(p.live.reason)
        : {
            status: "ok" as const,
            state: p.live.state,
            lastActivityAt: p.live.lastActivityAt,
          }
    ),
    stopped: stop
      ? { at: stop.at, left: stop.left, label: `Stopped ${stoppedWhere(stop)}` }
      : null,
    lastCompletion: packet?.lastCompletion ?? null,
    nextMove: packet
      ? {
          kind: packet.nextMove.kind,
          actor: packet.nextMove.actor,
          label: packet.nextMove.label,
          reason: packet.nextMove.reason,
          ...(packet.nextMove.proposalId
            ? { proposalId: packet.nextMove.proposalId }
            : {}),
          ...(packet.nextMove.sessionId
            ? { sessionId: packet.nextMove.sessionId }
            : {}),
          ...(packet.nextMove.url ? { url: packet.nextMove.url } : {}),
        }
      : {
          kind: "unknown",
          actor: "none",
          label: "Next move unknown",
          reason: "Where this session stands could not be read.",
        },
    ...(again
      ? {
          continue: {
            at: again.at,
            left: again.left,
            label: continueLabel(again),
          },
        }
      : {}),
    link: input.link,
  };
}
