/**
 * Applying the IS workspace-decision door's answer to a capture's structure
 * result (capture.structure step 1a′). Pure — no DB, no IO.
 *
 * The IS decides WHO answers `/api/workspace-tiebreak`: its typed decision
 * model (JEV, `decider: "jev"`, with a probability per candidate) or its LLM
 * cascade (`decider: "llm"`). Only a decision-model answer outranks the
 * structurer's catalog-wide pick: it is a dedicated, calibrated Choice over
 * the same candidates, where the structurer's pick is a side-output of
 * extraction. An LLM answer never replaces another LLM answer here.
 */

import { z } from "zod";
import type { WorkspaceTiebreakResult } from "@synap/intelligence-client";
import type { CapturePlacement, WorkspaceChoice } from "@synap-core/types";
import type { WorkspaceDecisionRecord } from "./ai-events.js";
import { resolveCaptureRouting } from "./capture-routing.js";

/**
 * The wire shape of a {@link WorkspaceDecisionRecord} on `capture.execute`'s
 * input (`aiWorkspaceDecision`) — ONE schema for every execute door (tRPC and
 * the hub REST codec), so a door cannot silently strip or loosen it.
 */
export const workspaceDecisionRecordSchema = z.object({
  decider: z.enum(["jev", "llm"]),
  model: z.string().max(200).optional(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
  candidates: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .max(50)
    .optional(),
}) satisfies z.ZodType<WorkspaceDecisionRecord>;

export interface WorkspacePickFields {
  targetWorkspaceId?: string | null;
  targetWorkspaceName?: string | null;
  targetWorkspaceReason?: string | null;
  targetWorkspaceConfidence?: number | null;
}

/** The recordable distribution behind a door answer (none for deterministic answers). */
export function toWorkspaceDecisionRecord(
  tb: WorkspaceTiebreakResult,
  candidates: ReadonlyArray<{ id: string; name: string }>
): WorkspaceDecisionRecord | undefined {
  if (!tb.decider) return undefined;
  return {
    decider: tb.decider,
    ...(tb.model ? { model: tb.model } : {}),
    ...(tb.probabilities ? { probabilities: tb.probabilities } : {}),
    candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
  };
}

/**
 * Overwrite `target`'s workspace pick with a decision-model answer. A pick
 * lands with the model's confidence; an abstain ("none of these fits") keeps
 * the capture in the ambient workspace with no confidence — the same honest
 * outcome as a tie-break abstain. Returns the record to carry to
 * `capture.execute`, or `undefined` (target untouched) when the answer did not
 * come from the decision model.
 */
export function applyDecisionModelPick(
  target: WorkspacePickFields,
  decision: WorkspaceTiebreakResult | null | undefined,
  candidates: ReadonlyArray<{ id: string; name: string }>,
  ambientWorkspaceId: string | null | undefined
): WorkspaceDecisionRecord | undefined {
  if (decision?.decider !== "jev") return undefined;
  const nameOf = (id: string | null | undefined) =>
    (id && candidates.find((c) => c.id === id)?.name) ?? null;
  const picked =
    decision.workspaceId &&
    candidates.some((c) => c.id === decision.workspaceId)
      ? decision.workspaceId
      : null;
  if (picked) {
    target.targetWorkspaceId = picked;
    target.targetWorkspaceName = nameOf(picked);
    target.targetWorkspaceConfidence = decision.confidence;
  } else {
    target.targetWorkspaceId = ambientWorkspaceId ?? null;
    target.targetWorkspaceName = nameOf(ambientWorkspaceId);
    target.targetWorkspaceConfidence = null;
  }
  target.targetWorkspaceReason = decision.reason;
  return toWorkspaceDecisionRecord(decision, candidates);
}

/**
 * Step 1c: the ontology left >1 candidates and the door was asked to break the
 * tie among ONLY those. Three outcomes, kept distinct:
 *  - a pick inside the candidates → it lands, with its distribution;
 *  - an abstain (or an id outside the set) → stay in the ambient workspace;
 *  - `null` = the door was UNAVAILABLE (the client returns null on any
 *    transport/HTTP failure). That is not an abstain: the prior pick survives
 *    when it is one of the candidates, else stay put — never a full-catalog
 *    guess the ontology already ruled out.
 */
export function applyTiebreakOutcome(
  target: WorkspacePickFields,
  tb: WorkspaceTiebreakResult | null,
  candidates: ReadonlyArray<{ id: string; name: string }>,
  ambientWorkspaceId: string | null | undefined,
  nameOf: (id: string | null | undefined) => string | null,
  priorDecision: WorkspaceDecisionRecord | undefined
): WorkspaceDecisionRecord | undefined {
  const inSet = (id: string | null | undefined) =>
    !!id && candidates.some((c) => c.id === id);
  const stayPut = (reason: string | null) => {
    target.targetWorkspaceId = ambientWorkspaceId ?? null;
    target.targetWorkspaceName = nameOf(ambientWorkspaceId);
    target.targetWorkspaceConfidence = null;
    target.targetWorkspaceReason = reason;
  };
  if (!tb) {
    if (inSet(target.targetWorkspaceId)) return priorDecision;
    stayPut(null);
    return undefined;
  }
  if (inSet(tb.workspaceId)) {
    target.targetWorkspaceId = tb.workspaceId;
    target.targetWorkspaceName =
      candidates.find((c) => c.id === tb.workspaceId)?.name ??
      nameOf(tb.workspaceId);
    target.targetWorkspaceConfidence = tb.confidence ?? null;
    target.targetWorkspaceReason = tb.reason || null;
  } else {
    stayPut(tb.reason || null);
  }
  return toWorkspaceDecisionRecord(tb, candidates);
}

// ── Capture destination (structure → review → execute) ──────────────────────

/**
 * `capture.execute`'s `workspaceChoice` — what the person did with the
 * destination before saving. ONE schema for every execute door (tRPC + the hub
 * REST codec).
 */
export const workspaceChoiceSchema = z.enum([
  "accepted",
  "changed",
  "removed",
  "ignored",
]) satisfies z.ZodType<WorkspaceChoice>;

/**
 * The ONE shape of the AI's pending "move to X?" suggestion on every
 * `capture.execute` outcome (applied AND proposed). Nothing was moved: the
 * capture landed where it would have without the AI; the caller confirms by
 * re-filing with an explicit workspace.
 */
export interface PendingWorkspaceSwitch {
  suggestedWorkspaceId: string;
  /** `null` when the pod could not name it (never a raw id in its place). */
  suggestedWorkspaceName: string | null;
  reason: string | null;
  confidence: number | null;
}

/** The ranked "Why?" rows a suggestion carries, suggestion first, at most 3. */
const MAX_ALTERNATIVES = 3;

/**
 * The honest `CapturePlacement` for a `capture.structure` result — the source
 * of truth every surface derives its destination from
 * (`deriveWorkspacePlacementView`, `@synap-core/types`).
 *
 * - `deterministic` (the step-1c ladder placed it: ontology / context /
 *   relational, rungs 1–4) → that workspace, `deterministic: true`, never a
 *   suggestion. It is not an AI guess, so it must never be demoted to one.
 * - otherwise the AMBIENT workspace, plus the AI's pick as a `suggestion` when
 *   it (a) differs from the ambient, (b) is one of the caller's routable
 *   workspaces (`routableIds` — the membership floor: an id outside it is
 *   never offered) that the pod can name, and (c) clears the SAME offer gate the
 *   execute ladder's rung 5 applies (`resolveCaptureRouting`, auto mode, the
 *   per-target tuned threshold when known). An interactive surface pre-fills a
 *   suggestion and saving accepts it, so a pick too weak for execute to even
 *   offer must not be pre-filled here either.
 *
 * `alternatives` come from the decider's distribution (`none` = abstain is
 * excluded), weight = probability, suggestion first; empty when there is no
 * distribution or it does not describe the suggestion.
 */
export function buildCapturePlacement(input: {
  ambientWorkspaceId: string | null;
  deterministic: { workspaceId: string } | null;
  aiPick: {
    workspaceId: string | null | undefined;
    reason: string | null | undefined;
    confidence: number | null | undefined;
  };
  decision: WorkspaceDecisionRecord | undefined;
  /** Display name of any workspace the caller belongs to (`null` = unknown). */
  nameOf: (id: string) => string | null;
  /** The caller's routable (domain-home, member) workspaces — the offer floor. */
  routableIds: ReadonlyArray<string>;
  /** Tuned rung-5 gate for the pick's target (undefined ⇒ the flat gate). */
  offerGate?: number;
}): CapturePlacement {
  const name = (id: string | null) => (id ? input.nameOf(id) : null);
  if (input.deterministic) {
    return {
      workspaceId: input.deterministic.workspaceId,
      workspaceName: name(input.deterministic.workspaceId),
      deterministic: true,
    };
  }
  const base: CapturePlacement = {
    workspaceId: input.ambientWorkspaceId,
    workspaceName: name(input.ambientWorkspaceId),
    deterministic: false,
  };
  const pick = input.aiPick.workspaceId;
  if (!pick || pick === input.ambientWorkspaceId) return base;
  const pickName = input.routableIds.includes(pick) ? input.nameOf(pick) : null;
  if (!pickName) return base;
  const offered = resolveCaptureRouting({
    mode: "auto",
    aiWorkspaceId: pick,
    aiConfidence: input.aiPick.confidence ?? null,
    currentWorkspaceId: input.ambientWorkspaceId ?? "",
    memberWorkspaceIds: [pick],
    minConfidence: input.offerGate,
  }).movedToWorkspace;
  if (offered !== pick) return base;
  return {
    ...base,
    suggestion: {
      workspaceId: pick,
      workspaceName: pickName,
      reason: input.aiPick.reason ?? null,
      alternatives: rankAlternatives(pick, input.decision, input.nameOf),
    },
  };
}

function rankAlternatives(
  suggestedId: string,
  decision: WorkspaceDecisionRecord | undefined,
  nameOf: (id: string) => string | null
): NonNullable<CapturePlacement["suggestion"]>["alternatives"] {
  const probs = decision?.probabilities;
  if (!probs || typeof probs[suggestedId] !== "number") return [];
  const nameFor = (id: string) =>
    decision?.candidates?.find((c) => c.id === id)?.name ?? nameOf(id);
  const rows = Object.entries(probs)
    .filter(([id]) => id !== "none")
    .flatMap(([id, weight]) => {
      const workspaceName = nameFor(id);
      return workspaceName ? [{ workspaceId: id, workspaceName, weight }] : [];
    });
  const suggested = rows.find((r) => r.workspaceId === suggestedId);
  if (!suggested) return [];
  const others = rows
    .filter((r) => r.workspaceId !== suggestedId)
    .sort((a, b) => b.weight - a.weight);
  return [suggested, ...others].slice(0, MAX_ALTERNATIVES);
}

/** What `capture.execute` records on the route decision event (and whether a capture-time correction rides with it). */
export interface RouteDecisionOutcome {
  /** What the AI CHOSE (its pick / the pending suggestion) — not where the data landed. */
  chosenWorkspaceId: string;
  /** The data landed where the AI chose (the person saved with the suggestion). */
  applied: boolean;
  choice: WorkspaceChoice | null;
  /** Set only for `changed`: the person filed it elsewhere at capture time. */
  correction: { fromWorkspaceId: string; toWorkspaceId: string } | null;
}

/**
 * Whether — and what — `capture.execute` records as the AI's route decision.
 *
 * - No AI pick ⇒ nothing to record.
 * - A PINNED capture (explicit `targetWorkspaceId`) records only when a
 *   suggestion was in play (`choice` present). The decision is the AI's pick;
 *   `applied` = the pin IS that pick. `changed` ⇒ exactly one correction
 *   (AI pick → pin). A pin with no choice is a deliberate placement with no
 *   suggestion shown — a deterministic rung or a person's own pick — and is
 *   NOT an AI decision (recording it would credit the AI with a ladder hit).
 * - An UNPINNED capture went through the ladder: the AI's suggestion (when
 *   rung 5 offered one) or where it landed, never applied (rung 5 proposes).
 */
export function routeDecisionOutcome(input: {
  pinnedWorkspaceId: string | null | undefined;
  aiWorkspaceId: string | null | undefined;
  choice: WorkspaceChoice | null | undefined;
  pendingSuggestionId: string | null | undefined;
  landedWorkspaceId: string | null | undefined;
}): RouteDecisionOutcome | null {
  const ai = input.aiWorkspaceId;
  if (!ai) return null;
  const choice = input.choice ?? null;
  const pin = input.pinnedWorkspaceId;
  if (pin) {
    if (!choice) return null;
    return {
      chosenWorkspaceId: ai,
      applied: pin === ai,
      choice,
      correction:
        choice === "changed" && pin !== ai
          ? { fromWorkspaceId: ai, toWorkspaceId: pin }
          : null,
    };
  }
  const chosen = input.pendingSuggestionId ?? input.landedWorkspaceId;
  if (!chosen) return null;
  return {
    chosenWorkspaceId: chosen,
    applied: false,
    choice,
    correction: null,
  };
}

/**
 * The "always file <kind> here?" OFFER a capture-time reroute earns.
 *
 * WHY IT IS AN OFFER AND NOT A RULE. Synap already has a first-class Rule
 * object — a `skills` row with `category: "rule"` whose sentence is compiled
 * into an automation (`routers/skills.ts:463 createRule` →
 * `services/rules/create.ts`, grammar in `services/rules/sentence-schema.ts`).
 * It cannot express this placement, and the ladder could not read it if it
 * could, on THREE counts measured in the code:
 *
 *  1. No THEN action files an entity into a named workspace. The sentence
 *     vocabulary is `notify | update_entity | create_entity | run_command |
 *     post_message | call_webhook` (`sentence-schema.ts:47`), and
 *     `entity_update`'s executor takes `{ entityId, properties, title,
 *     description }` and writes the AUTOMATION's own `workspaceId`
 *     (`packages/jobs/src/workers/steps/output.ts:512`) — there is no target
 *     workspace parameter to set.
 *  2. A rule fires AFTER the fact, off an event. Even with such an action it
 *     would MOVE an already-landed capture, which emits a route correction and
 *     tells routing memory the AI was wrong — the opposite of what a standing
 *     placement preference means.
 *  3. The placement ladder reads no rule store at all. `resolveWorkspacePlacement`
 *     (`@synap/database/services/workspace-resolution-service.ts`) has six
 *     rungs and the only rule-shaped input is the declared guild→workspace
 *     mapping at its rung 1 (`:665`).
 *
 * So this is deliberately NOT installable (`installable: false`): the pod says
 * what it would offer and why it cannot honour it yet, rather than inventing a
 * second routing store or bolting placement onto `governance_rules` (which is
 * AUTHORIZATION — auto-approve vs propose — and never routing). The offer is
 * also stamped on the route correction event so it is COUNTED, not dropped.
 */
export interface WorkspaceRuleOffer {
  /** The ONE kind the capture produced — an offer must name a single X. */
  profileSlug: string;
  /** Where the person actually filed it. */
  workspaceId: string;
  workspaceName: string | null;
  /** FALSE today — see the docblock. Never fabricate a `true` here. */
  installable: boolean;
  /** Why it cannot be installed yet, in the pod's own words. */
  reason: string;
}

export const WORKSPACE_RULE_OFFER_REASON =
  "This pod cannot yet store a standing placement rule: the placement ladder reads no rule store, and the Rule object's THEN vocabulary has no 'file into workspace' action. The preference was recorded on this capture's route correction.";

/**
 * The offer a capture-time reroute earns, or nothing.
 *
 * ONLY on a real correction (the person filed it somewhere other than the AI's
 * pick) AND only when the capture produced exactly ONE kind — "always file
 * <kind> here" is meaningless for a mixed capture, and guessing a dominant
 * kind would put words in the person's mouth.
 */
export function workspaceRuleOfferFor(input: {
  correction: RouteDecisionOutcome["correction"];
  /** Profile slugs of the entities this capture actually created. */
  profileSlugs: ReadonlyArray<string>;
  nameOf: (id: string) => string | null;
}): WorkspaceRuleOffer | undefined {
  const correction = input.correction;
  if (!correction) return undefined;
  const slugs = new Set(input.profileSlugs.filter((s) => !!s));
  if (slugs.size !== 1) return undefined;
  const profileSlug = [...slugs][0] as string;
  return {
    profileSlug,
    workspaceId: correction.toWorkspaceId,
    workspaceName: input.nameOf(correction.toWorkspaceId),
    installable: false,
    reason: WORKSPACE_RULE_OFFER_REASON,
  };
}

/**
 * A structure-time suggestion as the ONE pending-switch shape — for a door
 * that files straight from a structure result without calling execute (the
 * hub REST confirm mode). `confidence` is the AI pick's (structure's
 * `targetWorkspaceConfidence`).
 */
export function pendingSwitchFromPlacement(
  placement: CapturePlacement | null | undefined,
  confidence: number | null | undefined
): PendingWorkspaceSwitch | undefined {
  const s = placement?.suggestion;
  if (!s) return undefined;
  return {
    suggestedWorkspaceId: s.workspaceId,
    suggestedWorkspaceName: s.workspaceName || null,
    reason: s.reason,
    confidence: confidence ?? null,
  };
}
