/**
 * Prompt-quality scan — closes the loop on `promptVersion`.
 *
 * Every intake run records which prompt version structured it
 * (`focus_sessions.metadata.run.promptVersion`). Until this job nothing read it
 * back against what the humans then did with the proposals, so a prompt change
 * that made extraction worse was invisible. The scanner
 * (`notifyPromptVersionRegressions`,
 * `packages/api/src/services/intake/prompt-version-regression.ts`) compares a
 * newer prompt version's reject rate against the previous one for the same
 * engine + model and, past a conservative minimum sample, tells the pod admins
 * ONCE per regression through the notification registry.
 *
 * @synap/jobs cannot import @synap/api (circular dep), so apps/api fills the
 * slot at boot with `registerPromptVersionRegressionScanner`.
 *
 * An UNREGISTERED slot THROWS, and a failed scan propagates: pg-boss records a
 * failed job rather than a tick that quietly measured nothing.
 *
 * Queue: intake.prompt-quality-scan
 * Cron:  daily 40 3 * * * (after the tighten scan at 3:35)
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "prompt-quality-cron" });

export const PROMPT_QUALITY_SCAN_QUEUE = "intake.prompt-quality-scan";

/** Daily 03:40 UTC — after the tighten scan. */
export const PROMPT_QUALITY_SCAN_CRON = "40 3 * * *";

/** Structurally mirrors api's `notifyPromptVersionRegressions` result. */
export interface PromptQualityScanResult {
  regressions: number;
  notified: number;
  recipients: number;
  /** Set when a scan hit its cap: partial window, no verdict, nobody told. */
  skipped?: "truncated";
}

export type PromptVersionRegressionScanner =
  () => Promise<PromptQualityScanResult>;

let scanner: PromptVersionRegressionScanner | null = null;

export function registerPromptVersionRegressionScanner(
  fn: PromptVersionRegressionScanner
): void {
  scanner = fn;
}

export async function handlePromptQualityScan(): Promise<PromptQualityScanResult> {
  if (!scanner) {
    throw new Error(
      "Prompt-version regression scanner not registered — apps/api must call registerPromptVersionRegressionScanner() at boot"
    );
  }
  const result = await scanner();
  if (result.skipped === "truncated") {
    logger.error(
      result,
      "intake.prompt-quality-scan: scan TRUNCATED — partial window, no regression verdict, nobody told"
    );
  } else if (result.regressions > 0 && result.recipients === 0) {
    logger.error(
      result,
      "intake.prompt-quality-scan: regression found but the pod has no admin to tell"
    );
  } else {
    logger.info(result, "intake.prompt-quality-scan: complete");
  }
  return result;
}
