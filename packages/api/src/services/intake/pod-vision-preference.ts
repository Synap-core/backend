/**
 * Pod-wide `pod_settings.settings.intelligenceDefaults` readers for capture —
 * the preferred vision model (`.visionModelId`) and the consent to the
 * third-party decision model (`.thirdPartyDecisionModel`), both set by
 * `intelligence.setPodDefaults`.
 *
 * The vision model is a PREFERENCE, forwarded on the IS structure request: the IS always executes
 * and honours the id only when one of its enabled providers serves it. So a
 * failed read is logged and OMITTED — the IS then picks its own vision model,
 * and the extraction reports which model actually read the photo.
 */

import { podSettings } from "@synap/database/schema";
import type { db as DbType } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "intake/pod-vision-preference" });

/** The singleton row's `intelligenceDefaults` blob (throws on a failed read). */
async function selectIntelligenceDefaults(
  database: Pick<typeof DbType, "select">
): Promise<Record<string, unknown> | undefined> {
  const [row] = await database
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const defaults = (row?.settings as { intelligenceDefaults?: unknown })
    ?.intelligenceDefaults;
  return defaults && typeof defaults === "object"
    ? (defaults as Record<string, unknown>)
    : undefined;
}

export async function readPodVisionModelPreference(
  database: Pick<typeof DbType, "select">
): Promise<string | undefined> {
  try {
    const id = (await selectIntelligenceDefaults(database))?.visionModelId;
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  } catch (err) {
    logger.error(
      { err },
      "pod vision model preference read failed — the IS picks its own vision model"
    );
    return undefined;
  }
}

/**
 * The pod's CONSENT to the third-party decision model (TypeSafe JEV) —
 * `pod_settings.settings.intelligenceDefaults.thirdPartyDecisionModel`, set by
 * `intelligence.setPodDefaults`. Default OFF: only a stored `true` allows it.
 *
 * Unlike the vision preference above this is a CONSENT, not a preference, so
 * it fails CLOSED: a failed read never lets capture text leave for TypeSafe.
 * The failure is logged at error and kept DISTINCT from "not opted in"
 * (`reason`), so a broken read can never pass for a pod's deliberate choice.
 */
export type ThirdPartyDecisionModelConsent =
  | { allowed: true }
  | { allowed: false; reason: "not_opted_in" | "read_failed" };

export async function readPodThirdPartyDecisionModelConsent(
  database: Pick<typeof DbType, "select">
): Promise<ThirdPartyDecisionModelConsent> {
  try {
    const flag = (await selectIntelligenceDefaults(database))
      ?.thirdPartyDecisionModel;
    return flag === true
      ? { allowed: true }
      : { allowed: false, reason: "not_opted_in" };
  } catch (err) {
    logger.error(
      { err },
      "pod third-party decision model consent read FAILED — treating it as OFF (no capture content is sent to the decision model)"
    );
    return { allowed: false, reason: "read_failed" };
  }
}
