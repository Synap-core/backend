/**
 * THE POD RAISES A STAGE'S ASK; RUNS NEVER ASK (plan 08e4fba7 decision 5,
 * founder 9 Nov 2026).
 *
 * A run has no ask tool (the lean run tools, 2026-11-05), and when a
 * playbook's text and its run's tools disagree the tools win. A playbook that
 * needs a person's structured answer mid-run (choose next week's priorities,
 * pursue or drop a lead, the signed file) therefore DECLARES it on the stage
 * the answer ends: `stage.endAsk` (`PlaybookStageEndAsk`, validated by
 * `schemas/playbook-stage.ts`). This module is what the pod does with it:
 *
 *   TURN END (`settleRunTurnEnd`, a `completed` turn of a staged run): the
 *   first stage, from the session's current one on, whose ask this run has
 *   not raised yet — never past a stage with a gate the run has not entered
 *   (the gate is the person's step, and comes first). Found: the pod raises
 *   it as ONE owed slot through the one run-ask door (`raiseRunAsk`, the same
 *   as "Keep the run going"), records it in the run's ledger
 *   (`metadata.runTurns.stageAsks`: once per run), and parks the run
 *   `waiting_on_you` instead of completing it. None: the run completes, as
 *   before. A run whose stages declare no ask is unchanged.
 *
 *   ANSWER (`runTurnForAnswer`, the woken turn): the person's words are the
 *   message the run is woken with; this adds turn context naming the stage
 *   the answer ended, the chosen option's value, and the NEXT stage with its
 *   goal, so the run goes on from there.
 *
 * NOT done here, said so nobody reads it in: the pod does not move
 * `currentStage` on the answer. For a run with a subject the step IS the
 * subject's status, which the run moves from the answer (a lead the person
 * dropped must not enter "Pursue"); a stage per turn is the stage runner's
 * (session 1bab9f23).
 */

import {
  and,
  db,
  desc,
  eq,
  entities,
  focusSessions,
  isNull,
  playbookRuns,
  relations,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type {
  BlockedReason,
  ExpectedOutput,
  PlaybookStageEndAsk,
  SlotAnswerValue,
  SlotAsk,
  SlotAskChooseOption,
} from "@synap/playbooks";
import { stageEndAskSchema } from "../../schemas/playbook-stage.js";
import {
  mergeSessionMetadata,
  RUN_TURNS_META_KEY,
} from "../focus-sessions/session-metadata.js";
import { applyRunCapture } from "./apply-run-capture.js";
import { raiseRunAsk } from "./run-ask.js";

const logger = createLogger({ module: "stage-end-ask" });

/** Eight options at most (`ASK_LIMITS.optionsMax`); an option label, 80 chars. */
const OPTIONS_MAX = 8;
const OPTION_LABEL_MAX = 80;
/** A turn-context string (`TURN_CONTEXT_MAX_STRING_LENGTH`). */
const CONTEXT_STRING_MAX = 400;

/** A stage as a frozen definition carries it (stored jsonb: data). */
interface StoredStage {
  key: string;
  name?: string;
  goal?: string;
  gate?: unknown;
  endAsk?: unknown;
}

/** One stage-end ask the pod may raise, with the stage that follows it. */
export interface StageEndAskCandidate {
  stage: { key: string; name: string };
  endAsk: PlaybookStageEndAsk;
  next: { key: string; name: string; goal?: string } | null;
}

function storedStages(v: unknown): StoredStage[] {
  return Array.isArray(v)
    ? v.filter(
        (s): s is StoredStage =>
          !!s &&
          typeof s === "object" &&
          typeof (s as { key?: unknown }).key === "string"
      )
    : [];
}

const nameOf = (s: StoredStage) =>
  typeof s.name === "string" && s.name.trim() ? s.name.trim() : s.key;

/**
 * PURE. The stage-end asks a turn's end may raise, in stage order: from the
 * current stage (the first one when none or an unknown one is current), each
 * stage's valid `endAsk` this run has not `raised`, stopping BEFORE a later
 * stage that declares a gate (the run has not entered it; its gate is the
 * person's step, and comes first). An `endAsk` the ask schema refuses is
 * skipped, never raised half-formed.
 */
export function stageEndAskCandidates(
  stages: unknown,
  currentStage: string | null,
  raised: readonly string[]
): StageEndAskCandidate[] {
  const list = storedStages(stages);
  const at = currentStage ? list.findIndex((s) => s.key === currentStage) : -1;
  const start = at >= 0 ? at : 0;
  const out: StageEndAskCandidate[] = [];
  for (let i = start; i < list.length; i++) {
    const s = list[i]!;
    if (i > start && s.gate != null) break;
    if (s.endAsk == null || raised.includes(s.key)) continue;
    const parsed = stageEndAskSchema.safeParse(s.endAsk);
    if (!parsed.success) continue;
    const n = list[i + 1];
    out.push({
      stage: { key: s.key, name: nameOf(s) },
      endAsk: parsed.data as PlaybookStageEndAsk,
      next: n
        ? {
            key: n.key,
            name: nameOf(n),
            ...(typeof n.goal === "string" && n.goal.trim()
              ? { goal: n.goal.trim() }
              : {}),
          }
        : null,
    });
  }
  return out;
}

/**
 * PURE. The slot and its blocker for an ask: what the person owes is a
 * decision, a credential (a connection, a secret), or something only they
 * can do in the world (a file they hold, a step to take).
 */
export function stageAskSlot(
  endAsk: PlaybookStageEndAsk,
  stageName: string
): { slot: ExpectedOutput; blockedReason: BlockedReason } {
  const a = endAsk.ask;
  const blockedReason: BlockedReason =
    a.mode === "provide"
      ? a.provide.kind === "file"
        ? "physical"
        : "credential"
      : a.mode === "act"
        ? "physical"
        : "decision";
  const kind =
    a.mode === "provide"
      ? a.provide.kind
      : a.mode === "act"
        ? "action"
        : "decision";
  return {
    slot: {
      kind,
      label: endAsk.label,
      status: "pending",
      unblocks: endAsk.unblocks ?? `The run goes on after ${stageName}`,
    },
    blockedReason,
  };
}

/**
 * The entities linked TO the subject by `relation` (a variant `derived_from`
 * its asset), newest first, not deleted, the person's own: each an option
 * whose value is the entity id.
 */
async function relatedOptions(
  subjectEntityId: string,
  relation: string,
  userId: string,
  max: number
): Promise<SlotAskChooseOption[]> {
  if (max <= 0) return [];
  const rows = await db
    .select({ id: entities.id, title: entities.title })
    .from(relations)
    .innerJoin(entities, eq(entities.id, relations.sourceEntityId))
    .where(
      and(
        eq(relations.targetEntityId, subjectEntityId),
        eq(relations.type, relation),
        eq(entities.userId, userId),
        isNull(entities.deletedAt)
      )
    )
    .orderBy(desc(relations.createdAt))
    .limit(max);
  return rows.map((r) => ({
    label: (r.title?.trim() || r.id).slice(0, OPTION_LABEL_MAX),
    value: r.id,
  }));
}

/**
 * The ask as the person sees it. A `choose` with `optionsFrom` reads its
 * options now, before the declared ones, eight in all; none found ⇒ `null`
 * (nothing to choose among: the ask is not raised).
 */
async function askToRaise(
  c: StageEndAskCandidate,
  subjectEntityId: string | null,
  userId: string
): Promise<SlotAsk | null> {
  const a = c.endAsk.ask;
  if (!c.endAsk.optionsFrom || a.mode !== "choose") return a;
  if (!subjectEntityId) return null;
  const declared = a.options.slice(0, OPTIONS_MAX);
  const found = await relatedOptions(
    subjectEntityId,
    c.endAsk.optionsFrom.relation,
    userId,
    OPTIONS_MAX - declared.length
  );
  if (found.length === 0) return null;
  return { ...a, options: [...found, ...declared] };
}

/** The stages this run follows: its frozen definition, else the session's. */
async function runStages(
  runId: string,
  sessionStages: unknown
): Promise<unknown> {
  const [row] = await db
    .select({ snapshot: playbookRuns.definitionSnapshot })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, runId))
    .limit(1);
  const snap = row?.snapshot as { stages?: unknown } | null | undefined;
  return Array.isArray(snap?.stages) && snap.stages.length > 0
    ? snap.stages
    : sessionStages;
}

/**
 * Record (`add`) or take back (`remove`) one stage key in THIS run's ledger,
 * under the session row lock. `add` answers false when the key is already
 * there (another report of the same turn claimed it). A ledger of another
 * run is left alone.
 */
async function markStageAsk(
  sessionId: string,
  runId: string,
  stageKey: string,
  op: "add" | "remove"
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ metadata: focusSessions.metadata })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .for("update");
    const raw =
      locked?.metadata && typeof locked.metadata === "object"
        ? ((locked.metadata as Record<string, unknown>)[RUN_TURNS_META_KEY] as
            Record<string, unknown> | undefined)
        : undefined;
    if (!raw || raw.runId !== runId) return false;
    const keys = Array.isArray(raw.stageAsks)
      ? raw.stageAsks.filter((k): k is string => typeof k === "string")
      : [];
    if (op === "add" && keys.includes(stageKey)) return false;
    const next =
      op === "add" ? [...keys, stageKey] : keys.filter((k) => k !== stageKey);
    await tx
      .update(focusSessions)
      .set({
        metadata: mergeSessionMetadata({
          [RUN_TURNS_META_KEY]: { ...raw, stageAsks: next },
        }),
      })
      .where(eq(focusSessions.id, sessionId));
    return true;
  });
}

/**
 * A `completed` turn of a staged run: raise the next stage-end ask, if any.
 * `null` ⇒ nothing to ask: the caller completes the run, as before.
 * `waiting_on_you` ⇒ asked; the run is parked. `left_running` ⇒ the ask did
 * not land: the run stays live (never a false `completed`), and the next
 * turn's end asks again. Never throws.
 */
export async function settleStageEndAsk(p: {
  run: Parameters<typeof applyRunCapture>[0]["run"];
  session: { id: string; userId: string; channelId: string | null };
  askingAgentUserId: string | null;
  /** The run's ledger keys of the asks it already raised. */
  raised: readonly string[];
}): Promise<"waiting_on_you" | "left_running" | null> {
  try {
    const row = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, p.session.id),
      columns: {
        status: true,
        currentStage: true,
        stages: true,
        subjectEntityId: true,
      },
    });
    // A paused session waits on the person already (a gate, a hold).
    if (!row || row.status !== "active") return null;
    const stages = await runStages(p.run.id, row.stages);
    const candidates = stageEndAskCandidates(
      stages,
      row.currentStage ?? null,
      p.raised
    );
    for (const c of candidates) {
      if (!(await markStageAsk(p.session.id, p.run.id, c.stage.key, "add"))) {
        continue;
      }
      const ask = await askToRaise(
        c,
        row.subjectEntityId ?? null,
        p.session.userId
      );
      // Nothing to choose among: recorded (asked once per run), not raised.
      if (!ask) continue;
      const { slot, blockedReason } = stageAskSlot(c.endAsk, c.stage.name);
      const prompt =
        ask.mode === "confirm" && ask.prompt ? ` ${ask.prompt}` : "";
      const why =
        c.endAsk.why ??
        `The run finished ${c.stage.name}; your answer decides what it does next.`;
      const asked = await raiseRunAsk({
        runId: p.run.id,
        session: p.session,
        askingAgentUserId: p.askingAgentUserId,
        slot,
        blockedReason,
        why,
        question: `${why}${prompt}`,
        ask,
        idempotencyKey: `stage-ask:${p.run.id}:${c.stage.key}`,
      });
      if (!asked) {
        await markStageAsk(p.session.id, p.run.id, c.stage.key, "remove");
        return "left_running";
      }
      const parked = await applyRunCapture({
        run: p.run,
        status: "waiting_on_you",
      });
      return parked ? "waiting_on_you" : "left_running";
    }
    return null;
  } catch (err) {
    logger.error(
      { err, runId: p.run.id, sessionId: p.session.id },
      "stage-end-ask: could not settle the run's stage-end ask; the run stays live"
    );
    return "left_running";
  }
}

const cut = (s: string) =>
  s.length > CONTEXT_STRING_MAX ? `${s.slice(0, CONTEXT_STRING_MAX - 1)}…` : s;

/**
 * The turn context a person's answer to a stage-end ask adds to the woken
 * run turn: which stage it ended, the chosen option's value (an entity id
 * for options read from the pod), and the next stage with its goal. `[]`
 * when the answer is not to a stage-end ask this run raised.
 */
export async function stageAskTurnEntries(p: {
  runId: string;
  sessionStages: unknown;
  raised: readonly string[];
  slotLabel: string | null | undefined;
  value?: SlotAnswerValue;
}): Promise<Array<{ key: string; value: string }>> {
  const label = p.slotLabel?.trim().toLowerCase();
  if (!label || p.raised.length === 0) return [];
  const stages = storedStages(await runStages(p.runId, p.sessionStages));
  const i = stages.findIndex((s) => {
    if (!p.raised.includes(s.key)) return false;
    const parsed = stageEndAskSchema.safeParse(s.endAsk);
    return parsed.success && parsed.data.label.trim().toLowerCase() === label;
  });
  if (i < 0) return [];
  const stage = stages[i]!;
  const next = stages[i + 1];
  const entries: Array<{ key: string; value: string }> = [
    {
      key: "run.stageAsk.answered",
      value: cut(
        `The person answered "${p.slotLabel!.trim()}", the question that ends the ` +
          `${nameOf(stage)} stage. Their answer is the message you were woken with: ` +
          "act on it; never ask it again."
      ),
    },
  ];
  if (p.value?.type === "chip" && p.value.chip.value) {
    entries.push({
      key: "run.stageAsk.chosenValue",
      value: cut(p.value.chip.value),
    });
  }
  entries.push(
    next
      ? { key: "run.stageAsk.nextStage", value: cut(nameOf(next)) }
      : {
          key: "run.stageAsk.nextStage",
          value:
            "None: that was the last stage. Finish the run from the answer.",
        }
  );
  if (next && typeof next.goal === "string" && next.goal.trim()) {
    entries.push({
      key: "run.stageAsk.nextGoal",
      value: cut(next.goal.trim()),
    });
  }
  return entries;
}
