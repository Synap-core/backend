/**
 * THE SWEEP'S VERDICT, SAID IN THE ROOM — what the PR sweeper did with a
 * pull request's fate, posted as ONE line to each session it reached, through
 * the existing "say something in a session's room as the pod" door
 * (`postSessionNotice`, agent-dispatch/binding-call.ts).
 *
 * Before it, the verdict lived only in the job's return value and the jobs
 * log: from 29 to 31 Oct every `dev.pr_merged` the pod recorded for backend
 * (58 facts) completed nothing, because the key that posts them holds only
 * `event.create` and the sweep runs inside that grant (founder F1), so the
 * completion was `denied`. Nobody could see it: 50 outcomes were completed by
 * hand by their agents, 4 (#553, #542, #491, #490) stayed open on sessions
 * whose agent had gone.
 *
 * Every verdict that tells the reader something is posted: delivered,
 * withdrawn, waiting on review, claimed without proof, not on the default
 * branch, a session that names the PR but never declared it, and above all a
 * DENIAL, with the grant it lacked and what to do. `already_settled` (a replay,
 * or the agent was faster) says nothing new; `failed` is retried by the job and
 * logged there.
 *
 * Posted AS THE POD, outside the posting key's grant: the notice is the pod
 * reporting what it did, not a write the key makes. Idempotent per (event,
 * session, slot), so a retried job never posts twice. A notice that fails to
 * post is logged by the door and never undoes or fails the sweep.
 */

import { createLogger } from "@synap-core/core";
import type { PullRequestEvent } from "@synap-core/types";
import type { MergeSweepOutcome } from "./merge-sweeper.js";

const logger = createLogger({ module: "dev-loop/sweep-notice" });

export type SweepKind = "merged" | "closed";

/** The PR as a reader names it: `Synap-core/backend#553`. */
function prName(event: PullRequestEvent): string {
  return `${event.repo}#${event.number}`;
}

/** Strip the trailing period a door reason may carry, so lines end once. */
function clause(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

/**
 * The one room line for a sweep outcome, or null when it tells nothing new.
 * Pure: every word the room shows is here.
 */
export function sweepNoticeLine(
  kind: SweepKind,
  event: PullRequestEvent,
  outcome: MergeSweepOutcome
): string | null {
  const pr = prName(event);
  const slot = outcome.slotKey ? `"${outcome.slotKey}"` : null;
  const reason = outcome.reason ? clause(outcome.reason) : null;
  const fate =
    kind === "merged"
      ? `${pr} merged${event.base ? ` into ${event.base}` : ""}`
      : `${pr} closed without merging`;
  switch (outcome.result) {
    case "completed":
      return `${fate}: the pod recorded ${slot} as delivered.`;
    case "retired":
      return `${fate}: the pod withdrew ${slot}.`;
    case "claimed":
      return `${fate}: ${slot} is claimed, not verified yet (no evidence the pod accepts).`;
    case "proposed":
      return `${fate}: recording ${slot} waits for review${
        outcome.proposalId ? ` (proposal ${outcome.proposalId})` : ""
      }.`;
    case "not_default_base":
      return `${fate}, not the default branch: ${slot} stays open until the PR reaches it.`;
    case "no_outcome":
      return `${fate}. This session names it, but declares no outcome for it.`;
    case "denied":
      return `${fate}, but the pod could not record ${slot}: ${
        reason ?? "denied"
      }. ${
        kind === "merged"
          ? `Record it with completeOutput "${outcome.slotKey}"`
          : `Withdraw it with retireOutput "${outcome.slotKey}"`
      }, or give the key that posts PR facts the session.update grant.`;
    case "refused":
      return `${fate}, but the pod did not move ${slot}${
        reason ? `: ${reason}` : ""
      }.`;
    case "already_settled":
    case "failed":
      return null;
  }
}

/**
 * Post the sweep's verdict to each session's room. Never throws: a notice is
 * a report, and the sweep's own result stands without it.
 */
export async function postSweepNotices(p: {
  kind: SweepKind;
  event: PullRequestEvent;
  eventId: string;
  outcomes: readonly MergeSweepOutcome[];
}): Promise<void> {
  const lines = p.outcomes
    .map((o) => ({ o, line: sweepNoticeLine(p.kind, p.event, o) }))
    .filter((x): x is { o: MergeSweepOutcome; line: string } => !!x.line);
  if (lines.length === 0) return;
  try {
    const { postSessionNotice } =
      await import("../agent-dispatch/binding-call.js");
    for (const { o, line } of lines) {
      await postSessionNotice(
        o.sessionId,
        line,
        `dev-loop:${p.eventId}:${o.sessionId}:${o.slotKey ?? "none"}`
      );
    }
  } catch (err) {
    logger.error(
      { err, eventId: p.eventId },
      "PR sweeper: posting the verdict to the session room failed"
    );
  }
}
