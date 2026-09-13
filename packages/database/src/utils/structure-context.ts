/**
 * assembleStructureContext — THE ONE reading door for what a structure pass is
 * told beyond the input itself.
 *
 * Two callers structure raw input into a graph: interactive capture
 * (`routers/capture.ts` `structure`) and `message.interpret`
 * (`services/capabilities/builtin-verbs.ts`). Before this door only interpret
 * read stored guidelines, so a guideline changed one door and not the other
 * (intake plan B8). Both now pass their context here and receive:
 *
 *   - `instructions` — the text for the IS structure call's `instructions`
 *     field, under the SHARED budget (`STRUCTURE_INSTRUCTIONS_BUDGET`, which
 *     mirrors the 2000-char cap on BOTH sides: IS `routes/structure.ts` and
 *     `capture.structure`'s input schema — over it the IS rejects the call);
 *   - `guidelines` — the `{id, version}` of every guideline that made it INTO
 *     the text, for a run manifest;
 *   - `dropped` — guidelines that matched but did not fit, and `truncated`;
 *   - `guidelineStatus` — `"unavailable"` when the guideline READ failed. A
 *     failed read is not "no guidelines": the caller still structures (with
 *     its own instructions) but can say the guidelines were not applied.
 *
 * APPLICATION ORDER (the text): guidelines general → specific, then
 * import-context guidance, then the caller's explicit instructions LAST, so the
 * most specific / most deliberate text is read last and wins.
 *
 * BUDGET PRIORITY (what survives when over): explicit instructions first (a
 * lone explicit text over budget is hard-sliced — the one cut that can split a
 * sentence, because the caller already exceeded the IS contract), then import
 * guidance, then guidelines from MOST specific to least, each WHOLE or not at
 * all. Deterministic: same inputs ⇒ same bytes. A drop is logged with ids.
 *
 * NO-OP CONTRACT: when no guideline matches and there is no import guidance,
 * `instructions` is byte-identical to the explicit parts joined by "\n\n" (or
 * undefined when there are none) — what both callers produced before.
 */

import { createLogger } from "@synap-core/core";
import { GUIDELINE_TEXT_MAX, resolveGuidelines } from "./config-settings.js";
import type {
  ResolveGuidelinesInput,
  ResolvedGuideline,
} from "./config-settings.js";

const logger = createLogger({ module: "structure-context" });

/**
 * The shared cap on a structure call's `instructions` (IS + capture both 2000).
 * The SAME number as one guideline's text cap, by construction: the most
 * specific guideline must always be able to fit the budget whole.
 */
export const STRUCTURE_INSTRUCTIONS_BUDGET = GUIDELINE_TEXT_MAX;

const SEPARATOR = "\n\n";

export interface GuidelineRef {
  id: string;
  version: number;
}

export interface StructureContext {
  instructions: string | undefined;
  guidelines: GuidelineRef[];
  dropped: GuidelineRef[];
  truncated: boolean;
  guidelineStatus: "ok" | "unavailable";
}

export interface ComposeStructureContextInput {
  /** Resolved guidelines, general → specific (as `resolveGuidelines` returns). */
  guidelines: readonly ResolvedGuideline[];
  /** Import-context guidance (e.g. an import run's per-source notes). */
  importGuidance?: string | null;
  /** The caller's own instruction blocks, in order. Blank entries are skipped. */
  instructions?: ReadonlyArray<string | null | undefined>;
  budget?: number;
}

/**
 * How a guideline reads inside the prompt. An `entityKind` guideline is matched
 * because its kind is AVAILABLE to the extractor, not because it was produced,
 * so its text names the kind it is for. Every other rung matched the actual
 * context and needs no framing.
 */
export function guidelinePromptText(g: ResolvedGuideline): string {
  if (g.scopeKind === "entityKind" && g.scopeRef) {
    return `When structuring a "${g.scopeRef}": ${g.text}`;
  }
  return g.text;
}

/** Pure: compose + budget. See the file header for order and priority. */
export function composeStructureContext(
  input: ComposeStructureContextInput
): Omit<StructureContext, "guidelineStatus"> {
  const budget = input.budget ?? STRUCTURE_INSTRUCTIONS_BUDGET;
  const explicit = (input.instructions ?? [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0);
  const importGuidance = input.importGuidance?.trim() || undefined;

  // Fixed (non-guideline) tail, in application order.
  const tail = [...(importGuidance ? [importGuidance] : []), ...explicit];
  let tailText = tail.join(SEPARATOR);
  let truncated = false;
  if (tailText.length > budget) {
    // Keep explicit over import guidance; slice only as a last resort.
    const explicitText = explicit.join(SEPARATOR);
    tailText =
      explicitText.length <= budget && explicitText.length > 0
        ? explicitText
        : (explicitText || tailText).slice(0, budget);
    truncated = true;
  }

  // Guidelines: admit most-specific first, whole or not at all.
  const admitted = new Set<number>();
  let used = tailText.length;
  const dropped: GuidelineRef[] = [];
  for (let i = input.guidelines.length - 1; i >= 0; i--) {
    const g = input.guidelines[i]!;
    const cost =
      guidelinePromptText(g).length + (used > 0 ? SEPARATOR.length : 0);
    if (used + cost <= budget) {
      admitted.add(i);
      used += cost;
    } else {
      dropped.push({ id: g.id, version: g.version });
      truncated = true;
    }
  }

  const kept = input.guidelines.filter((_, i) => admitted.has(i));
  const parts = [
    ...kept.map(guidelinePromptText),
    ...(tailText ? [tailText] : []),
  ];
  return {
    instructions: parts.length > 0 ? parts.join(SEPARATOR) : undefined,
    guidelines: kept.map((g) => ({ id: g.id, version: g.version })),
    dropped: dropped.reverse(),
    truncated,
  };
}

export type AssembleStructureContextInput = ResolveGuidelinesInput &
  Omit<ComposeStructureContextInput, "guidelines">;

/**
 * Resolve guidelines for the structuring context and compose them with the
 * caller's instructions. Never throws for a guideline READ failure — it returns
 * `guidelineStatus: "unavailable"` with the explicit-only text instead.
 */
export async function assembleStructureContext(
  input: AssembleStructureContextInput
): Promise<StructureContext> {
  const { importGuidance, instructions, budget, ...resolveInput } = input;
  let guidelines: ResolvedGuideline[] = [];
  let guidelineStatus: StructureContext["guidelineStatus"] = "ok";
  try {
    guidelines = await resolveGuidelines(resolveInput);
  } catch (err) {
    guidelineStatus = "unavailable";
    logger.error(
      { err, userId: input.userId, workspaceId: input.workspaceId },
      "structure-context: guideline read failed — structuring WITHOUT stored guidelines"
    );
  }
  const composed = composeStructureContext({
    guidelines,
    importGuidance,
    instructions,
    budget,
  });
  if (composed.truncated) {
    logger.warn(
      {
        userId: input.userId,
        budget: budget ?? STRUCTURE_INSTRUCTIONS_BUDGET,
        kept: composed.guidelines,
        dropped: composed.dropped,
      },
      "structure-context: instructions over budget — dropped the least specific guidelines"
    );
  }
  return { ...composed, guidelineStatus };
}
