/**
 * The model tier a run turn asks for: the ACTIVE stage's `tier`
 * (`PlaybookStage.tier`, plan fbfadf54 5a). It rides the run profile to the
 * IS, which maps it to a model above its message classifier and below a
 * person's own model choice (IS `agents/base/run-profile.ts`).
 */
import { PLAYBOOK_STAGE_TIERS, type PlaybookStageTier } from "@synap/playbooks";

/**
 * The `tier` of the stage keyed `currentStage`, read tolerantly off the
 * playbook's stages bag. PURE. No stage, no such key, or a value outside the
 * closed set: no tier (the IS keeps its own choice).
 */
export function activeStageTier(
  stages: unknown,
  currentStage: string | null
): PlaybookStageTier | undefined {
  if (!currentStage || !Array.isArray(stages)) return undefined;
  const stage = stages.find(
    (s): s is { key: string; tier?: unknown } =>
      !!s &&
      typeof s === "object" &&
      (s as { key?: unknown }).key === currentStage
  );
  const tier = stage?.tier;
  return (PLAYBOOK_STAGE_TIERS as readonly unknown[]).includes(tier)
    ? (tier as PlaybookStageTier)
    : undefined;
}
