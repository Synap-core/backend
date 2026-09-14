/**
 * The pod's preferred vision model — `pod_settings.settings.intelligenceDefaults
 * .visionModelId`, set by `intelligence.setPodDefaults`.
 *
 * A PREFERENCE, forwarded on the IS structure request: the IS always executes
 * and honours the id only when one of its enabled providers serves it. So a
 * failed read is logged and OMITTED — the IS then picks its own vision model,
 * and the extraction reports which model actually read the photo.
 */

import { podSettings } from "@synap/database/schema";
import type { db as DbType } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "intake/pod-vision-preference" });

export async function readPodVisionModelPreference(
  database: Pick<typeof DbType, "select">
): Promise<string | undefined> {
  try {
    const [row] = await database
      .select({ settings: podSettings.settings })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);
    const defaults = (
      row?.settings as { intelligenceDefaults?: { visionModelId?: unknown } }
    )?.intelligenceDefaults;
    const id = defaults?.visionModelId;
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  } catch (err) {
    logger.error(
      { err },
      "pod vision model preference read failed — the IS picks its own vision model"
    );
    return undefined;
  }
}
