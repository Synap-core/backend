/**
 * Pod-wide `pod_settings.settings.intelligenceDefaults` reader for capture —
 * the preferred vision model (`.visionModelId`), set by
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
