/**
 * A STAGE'S OUTCOMES, and whether they are MET: the one reading of "this
 * step's work is done" (work model W6). Three readers ask it and nothing else:
 *
 *   - the step that advances by itself (`advance-if-stage-met.ts`): every
 *     required outcome of the current stage met, at least one met;
 *   - a session's check gate (`stage-gate.ts` `checkGateFailing`): the
 *     required outcomes of the stage left that are not met hold it;
 *   - approval signal 1 of a stage's `onApproved` (decision D2,
 *     {@link stageOutputsApproved}): a stage that declares outputs, all met.
 *
 * "Met" is the W4 projection's (`projectSessionOutcomes` /
 * `unmetRequiredOutcomes`, `@synap-core/types/units`), never a second
 * reading: an output a required criterion checks is met only when that
 * criterion passes (D4 a), a retired one is neither met nor owed.
 *
 * AT A STEP, A LATER STEP'S CRITERION NEVER COUNTS (lead default on D4 a's
 * reading, W6 review): the criteria counted are those of the step judged, of
 * the steps before it in the process's order, and those with no step (their
 * `stageKey` unset). The projection is read over that narrower list, never
 * re-derived. A later step's criterion (a merge check on the pull request
 * the PR step declares) decides the output at its own step: counted here it
 * held `pr-opened ⇒ checks` until the merge, which comes after checks. Only
 * what "this step is met" means changes: the session's verdict and its close
 * stay stage-blind, as W4 decided.
 *
 * A LEAF (no database, no door): the status writer, the slot merge
 * (`stage-slots.ts`) and the gate all read it, and none must load the update
 * door to answer a pure question.
 */
import type { ExpectedOutput, SessionCriterion } from "@synap/playbooks";
import {
  projectSessionOutcomes,
  unmetRequiredOutcomes,
  type OutcomeCriterionLike,
  type SessionOutcome,
} from "@synap-core/types/units";
import type { EvaluationRowLike } from "@synap-core/types/focus-sessions";
import { normalizeExpectedLabel } from "./expected-label.js";

/** The declared outputs of stage `stageKey`, or [] (unknown stage, none declared). */
export function declaredStageOutputs(
  stages: unknown,
  stageKey: string | null
): ExpectedOutput[] {
  if (!stageKey || !Array.isArray(stages)) return [];
  const stage = stages.find(
    (s) =>
      !!s && typeof s === "object" && (s as { key?: unknown }).key === stageKey
  ) as { expectedOutputs?: unknown } | undefined;
  return Array.isArray(stage?.expectedOutputs)
    ? (stage.expectedOutputs as ExpectedOutput[])
    : [];
}

/** What the stage reading needs: the session's stored slots, criteria and grades. */
export interface StageOutcomesInput {
  /** `focus_sessions.expected_outputs`, raw. */
  expectedOutputs: unknown;
  criteria?: readonly (SessionCriterion | OutcomeCriterionLike)[] | null;
  /** The session's evaluation rows (all, or the latest per criterion). */
  evaluations?: readonly EvaluationRowLike[] | null;
}

export interface StageOutcomes {
  /** The stage's outcomes, as the projection reads them. */
  outcomes: SessionOutcome[];
  /**
   * The keys holding the stage: its required outcomes not met, plus each
   * required output it declares that the session does not carry (by its
   * declared key, else its label).
   */
  unmet: string[];
  /**
   * The OUTPUTS among `unmet` (never a criterion's fact), with their kind:
   * what a held gate tells the agent to deliver ({@link owedOutputHint}).
   */
  unmetOutputs: Array<{
    key: string;
    kind: string | null;
    /**
     * The required criteria that name it but do not count at this step (a
     * later step's): the doors leave such an output to them, so completing it
     * does not meet it here.
     */
    decidedLater: string[];
  }>;
  /** Every required outcome met, and at least one outcome met. */
  met: boolean;
}

/**
 * The outcomes of stage `stageKey`: the outputs it declares (matched to the
 * session's slots by declared key, else label: trim + casefold, like
 * `stageSlotsToAdd`) and every outcome a criterion of the stage checks (its
 * `stageKey`). A stage with none is never met and holds nothing. PURE.
 */
export function readStageOutcomes(
  stages: unknown,
  stageKey: string | null,
  input: StageOutcomesInput
): StageOutcomes {
  if (!stageKey) {
    return { outcomes: [], unmet: [], unmetOutputs: [], met: false };
  }
  const all = (input.criteria ?? []) as OutcomeCriterionLike[];
  const order = stageKeysOf(stages);
  const at = order.indexOf(stageKey);
  const scope = new Set(at >= 0 ? order.slice(0, at + 1) : [stageKey]);
  const counted = all.filter((c) => !c.stageKey || scope.has(c.stageKey));
  const { outcomes } = projectSessionOutcomes({
    expectedOutputs: input.expectedOutputs,
    criteria: counted,
    evaluations: input.evaluations ?? [],
    sessionTerminal: false,
  });
  const decidedLater = (key: string) =>
    all
      .filter(
        (c) =>
          c.outputKey === key && c.required !== false && !counted.includes(c)
      )
      .map((c) => c.key);
  const picked = new Set<SessionOutcome>();
  const missing: StageOutcomes["unmetOutputs"] = [];
  for (const o of declaredStageOutputs(stages, stageKey)) {
    const key = (o as { key?: unknown }).key;
    const label = normalizeExpectedLabel(o?.label);
    const found =
      (typeof key === "string"
        ? outcomes.find((x) => x.source !== "criterion" && x.key === key)
        : undefined) ??
      (label
        ? outcomes.find(
            (x) =>
              x.source !== "criterion" &&
              normalizeExpectedLabel(x.slotLabel) === label
          )
        : undefined);
    if (found) picked.add(found);
    else if ((o as { optional?: unknown }).optional !== true) {
      missing.push({
        key: typeof key === "string" && key ? key : (o?.label ?? ""),
        kind: typeof o?.kind === "string" ? o.kind : null,
        decidedLater: [],
      });
    }
  }
  for (const x of outcomes) {
    if (x.stageKey === stageKey) picked.add(x);
    else if (x.criteria?.some((c) => c.stageKey === stageKey)) picked.add(x);
  }
  const list = [...picked];
  const held = new Set(unmetRequiredOutcomes(list));
  const unmetOutputs = [
    ...list
      .filter((x) => held.has(x.key) && x.source !== "criterion")
      .map((x) => ({
        key: x.key,
        kind: x.kind ?? null,
        decidedLater: decidedLater(x.key),
      })),
    ...missing,
  ];
  const unmet = [...held, ...missing.map((m) => m.key)];
  return {
    outcomes: list,
    unmet,
    unmetOutputs,
    met: unmet.length === 0 && list.some((x) => x.met),
  };
}

/**
 * How the agent delivers an output a stage still owes — the line a held check
 * gate carries (its hold reason, and the session's nudge). An agent that
 * recorded its pull request as a NEW outcome (`pr-<repo>-<n>`) still owes the
 * slot the stage declared: nothing pairs the two but the slot's own key. An
 * output a later step's criterion decides cannot be completed by a claim (the
 * doors leave it to that criterion): a criterion of THIS step must name it.
 * PURE.
 */
export function owedOutputHint(
  o: StageOutcomes["unmetOutputs"][number]
): string {
  if (o.decidedLater.length > 0) {
    return `Output "${o.key}" is owed here, but ${o.decidedLater.map((k) => `"${k}"`).join(", ")} decide${o.decidedLater.length === 1 ? "s" : ""} it later, so completing it does not meet it now: name it by outputKey "${o.key}" in a criterion of this step.`;
  }
  return o.kind === "pull_request"
    ? `Output "${o.key}" is owed: complete it with your PR's url (completeOutput "${o.key}" with ref.url).`
    : `Output "${o.key}" is owed: complete it with its evidence (completeOutput "${o.key}" with its ref).`;
}

/** The stage keys of a process, in order. */
function stageKeysOf(stages: unknown): string[] {
  return Array.isArray(stages)
    ? stages
        .map((s) => (s as { key?: unknown } | null)?.key)
        .filter((k): k is string => typeof k === "string")
    : [];
}

/**
 * Is stage `stageKey`'s declared work APPROVED — approval signal 1 of a
 * stage's `onApproved` (decision D2)? The stage declares outputs, and it is
 * met ({@link readStageOutcomes}): every required outcome met (delivered, and
 * passing the criteria that check it), at least one. False for a stage with
 * no declared outputs: its approval is the next stage's gate (signal 2), or
 * nothing. PURE.
 */
export function stageOutputsApproved(
  stages: unknown,
  stageKey: string | null,
  input: StageOutcomesInput
): boolean {
  if (declaredStageOutputs(stages, stageKey).length === 0) return false;
  return readStageOutcomes(stages, stageKey, input).met;
}

/** A slot a door just settled: its key, and its stored label. */
export interface SettledSlot {
  key?: string | null;
  label?: string | null;
}

/**
 * The stages that DECLARE one of the `settled` slots, in stage order —
 * matched like {@link readStageOutcomes}: declared key, else label (trim +
 * casefold). A run may have moved on before its slot settled (a merge, a
 * person's approval of a sent message): the stage whose work it was still
 * reaches its status (decision D2). PURE.
 */
export function stagesDeclaringSlots(
  stages: unknown,
  settled: readonly SettledSlot[]
): string[] {
  if (!Array.isArray(stages) || settled.length === 0) return [];
  const keys = new Set(
    settled.map((s) => s.key).filter((k): k is string => !!k)
  );
  const labels = new Set(
    settled
      .map((s) => normalizeExpectedLabel(s.label ?? undefined))
      .filter((l): l is string => !!l)
  );
  const out: string[] = [];
  for (const stage of stages) {
    const key = (stage as { key?: unknown } | null)?.key;
    if (typeof key !== "string") continue;
    const declares = declaredStageOutputs(stages, key).some((o) => {
      const k = (o as { key?: unknown }).key;
      if (typeof k === "string" && keys.has(k)) return true;
      const label = normalizeExpectedLabel(o?.label);
      return !!label && labels.has(label);
    });
    if (declares) out.push(key);
  }
  return out;
}
