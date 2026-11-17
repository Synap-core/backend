/**
 * THE REACTIONS REACTOR (plan 7d71ddcc, wave 2, decision D1) — one reactor
 * after the outbox applies every rule "when X moves, move Y", generalised from
 * `holdResumeReactor` (`hold-resume.ts`): subject-generic, no workspace gate,
 * one deduped job per move.
 *
 *   1. the reactor sees every transition (`action === 'transition'`) whose
 *      subject type some rule listens to, and queues ONE job for it
 *      (`singletonKey reaction:<eventId>`: a redelivered move is one job);
 *   2. the job reads the move from the transition log (the truth, not the
 *      event copy), lists the rules (`listReactions`, built-in and declared)
 *      that match it, and has each one's effect PLAN its writes (read only);
 *   3. the guards decide (`decideReactionWrites`): paused, chaining, depth,
 *      order, conflicts, and D3 (done/lost is proposed);
 *   4. each write goes through the TARGET's own door as the `system`, with a
 *      `cause` (`{reactionId, transitionId, chainId, depth}`), so the
 *      target's history says "moved because X moved"; a compare-and-set that
 *      finds another status is a person's move winning (D6): skipped;
 *   5. every outcome — applied, proposed, skipped with its reason — is logged
 *      (`recordReactionOutcomes`).
 *
 * A reaction is not "the AI" (D6): it acts on the person's own declaration,
 * not re-governed, like a hold's resume. Holds stay in `hold-resume.ts`
 * (folding them in is wave 5). User-authored automations stay on the matcher.
 */
import {
  db,
  eq,
  lifecycleTransitionOutbox,
  recordReactionOutcomes,
  type ReactionLogEntry,
} from "@synap/database";
import { registerReactor, type Reactor } from "@synap/events";
import { createLogger } from "@synap-core/core";
import type {
  AnyTransitionPayload,
  TransitionSubjectType,
} from "@synap-core/types/lifecycle";
import {
  decideReactionWrites,
  listReactions,
  reactionMatches,
  reactionSubjectTypes,
  type DecidedWrite,
  type PlannedWrite,
  type ReactionDeclaration,
  type SkippedWrite,
} from "../utils/reactions.js";
import {
  reactionEffectOf,
  type ReactionEffectOutcome,
} from "../utils/reaction-effects.js";

const logger = createLogger({ module: "reactions" });

export const REACTIONS_QUEUE = "reactions";

export interface ReactionsJobData {
  transitionId: string;
}

export interface ReactionsJobResult {
  applied: number;
  proposed: number;
  skipped: number;
}

/** The move, read off the transition log by its id. */
async function readTransition(
  transitionId: string
): Promise<AnyTransitionPayload | null> {
  const [row] = await db
    .select({ transition: lifecycleTransitionOutbox.transition })
    .from(lifecycleTransitionOutbox)
    .where(eq(lifecycleTransitionOutbox.transitionId, transitionId))
    .limit(1);
  if (!row) return null;
  const t = (
    typeof row.transition === "string"
      ? JSON.parse(row.transition)
      : row.transition
  ) as AnyTransitionPayload;
  return t && typeof t.to === "string" ? t : null;
}

const subjectOf = (t: AnyTransitionPayload) =>
  `${t.subjectType}:${t.subjectId}`;
const targetOf = (w: PlannedWrite) =>
  `${w.target.subjectType}:${w.target.subjectId}`;

function logEntry(
  t: AnyTransitionPayload,
  d: {
    reaction: ReactionDeclaration;
    write: PlannedWrite;
    cause: DecidedWrite["cause"];
  },
  outcome: ReactionLogEntry["outcome"],
  code: string,
  reason: string,
  proposalId?: string
): ReactionLogEntry {
  return {
    reactionId: d.reaction.id,
    outcome,
    code,
    reason,
    userId: d.write.ownerUserId || t.userId,
    sourceTransitionId: t.transitionId,
    source: subjectOf(t),
    target: targetOf(d.write),
    to: d.write.to,
    chainId: d.cause.chainId,
    depth: d.cause.depth,
    proposalId: proposalId ?? null,
    sessionId:
      d.write.target.subjectType === "focus_session"
        ? d.write.target.subjectId
        : (t.sessionId ?? null),
    workspaceId: t.workspaceId ?? null,
  };
}

/** Apply (or propose) one decided write; never throws for a refusal. */
async function applyOne(
  t: AnyTransitionPayload,
  d: DecidedWrite
): Promise<
  ReactionEffectOutcome | { status: "needs_proposal" | "effect_unavailable" }
> {
  const effect = reactionEffectOf(d.reaction.do.effect);
  if (!effect) return { status: "effect_unavailable" };
  const ctx = { transition: t, reaction: d.reaction, cause: d.cause };
  if (d.mode === "propose") {
    if (!effect.propose) return { status: "needs_proposal" };
    return effect.propose(d.write, ctx);
  }
  return effect.apply(d.write, ctx);
}

/**
 * The job: one move, every rule that matches it. A failed write throws after
 * the others ran and were logged, so pg-boss retries the move; a write that
 * already landed is then `unchanged` (its compare-and-set no longer matches),
 * so a retry never moves anything twice.
 */
export async function handleReactions(
  data: ReactionsJobData
): Promise<ReactionsJobResult> {
  const result: ReactionsJobResult = { applied: 0, proposed: 0, skipped: 0 };
  const t = await readTransition(data.transitionId);
  if (!t) return result;
  const all = await listReactions();
  const matching = all.filter((r) => reactionMatches(r, t));
  if (matching.length === 0) return result;

  const log: ReactionLogEntry[] = [];
  const planned: Array<{
    reaction: ReactionDeclaration;
    writes: PlannedWrite[];
  }> = [];
  for (const reaction of matching) {
    const effect = reactionEffectOf(reaction.do.effect);
    if (!effect) {
      // Nothing can be planned without its door: said once per move.
      log.push({
        reactionId: reaction.id,
        outcome: "skipped",
        code: "effect_unavailable",
        reason: `The door behind "${reaction.title}" is not available in this process.`,
        userId: t.userId,
        sourceTransitionId: t.transitionId,
        source: subjectOf(t),
        target: null,
        to: null,
        chainId: t.cause?.chainId ?? t.transitionId,
        depth: (t.cause?.depth ?? 0) + 1,
        workspaceId: t.workspaceId ?? null,
      });
      continue;
    }
    planned.push({ reaction, writes: await effect.plan(t, reaction) });
  }

  const causedBy = t.cause?.reactionId
    ? (all.find((r) => r.id === t.cause!.reactionId) ?? null)
    : null;
  const { decided, skipped } = decideReactionWrites({
    source: t,
    planned,
    causedBy,
  });
  for (const s of skipped as SkippedWrite[]) {
    log.push(logEntry(t, s, "skipped", s.code, s.reason));
  }

  let failure: unknown = null;
  for (const d of decided) {
    try {
      const out = await applyOne(t, d);
      switch (out.status) {
        case "applied":
          result.applied++;
          log.push(
            logEntry(
              t,
              d,
              "applied",
              "applied",
              `"${d.reaction.title}": moved to ${d.write.to} because ${subjectOf(t)} moved to ${t.to}.`
            )
          );
          break;
        case "proposed":
          result.proposed++;
          log.push(
            logEntry(
              t,
              d,
              "proposed",
              "proposed",
              `"${d.reaction.title}": a move into ${d.write.toCategory} is proposed, not applied.`,
              out.proposalId
            )
          );
          break;
        case "unchanged":
          break;
        case "moved_meanwhile":
          log.push(logEntry(t, d, "skipped", "moved_meanwhile", out.reason));
          break;
        case "refused":
          log.push(logEntry(t, d, "skipped", "refused", out.reason));
          break;
        case "needs_proposal":
          log.push(
            logEntry(
              t,
              d,
              "skipped",
              "needs_proposal",
              `A move into ${d.write.toCategory} must be proposed, and "${d.reaction.title}" cannot file one.`
            )
          );
          break;
        case "effect_unavailable":
          log.push(
            logEntry(
              t,
              d,
              "skipped",
              "effect_unavailable",
              `The door behind "${d.reaction.title}" is not available in this process.`
            )
          );
          break;
      }
    } catch (err) {
      failure = err;
      log.push(
        logEntry(
          t,
          d,
          "skipped",
          "failed",
          err instanceof Error ? err.message : String(err)
        )
      );
      logger.warn(
        { err, reactionId: d.reaction.id, transitionId: t.transitionId },
        "reaction failed — the job is retried"
      );
    }
  }
  result.skipped = log.filter((l) => l.outcome === "skipped").length;
  try {
    await recordReactionOutcomes(db, log);
  } catch (err) {
    // The log is history: a failed append never undoes or repeats a move.
    logger.warn(
      { err, transitionId: t.transitionId },
      "reaction log append failed"
    );
  }
  if (failure) throw failure;
  return result;
}

/**
 * Every move some rule listens to: sent to the queue (off the emit path),
 * where the job decides. A redelivered move is one job, not two.
 */
export const reactionsReactor: Reactor = {
  id: "reactions",
  match: (payload) =>
    payload.action === "transition" &&
    reactionSubjectTypes().has(payload.subjectType as TransitionSubjectType),
  async handler(payload, { boss }) {
    // The move's own id (the outbox key; the event row's id is the same).
    const transitionId =
      typeof payload.data?.transitionId === "string"
        ? payload.data.transitionId
        : (payload.eventId ?? null);
    if (!transitionId) return;
    await boss.send(
      REACTIONS_QUEUE,
      { transitionId } satisfies ReactionsJobData,
      { singletonKey: `reaction:${transitionId}` }
    );
  },
};

let registered = false;

/** Register the reactor; called once where the workers register. */
export function registerReactionsReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(reactionsReactor);
}
