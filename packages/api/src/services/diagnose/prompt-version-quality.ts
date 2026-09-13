/**
 * The `quality_by_prompt_version` section of whole-pod diagnose.
 *
 * The numbers come from `services/intake/quality-by-prompt-version.ts` (the
 * denominator, grouping and regression thresholds are documented there). This
 * module only turns the read into a signal and the signal into a section.
 *
 * AN UNAVAILABLE READ IS NOT A ZERO. A failed gather becomes
 * `{ available: false, error }` and the section SAYS it could not be read,
 * with `attention` status. Folding it into "no runs" would render a broken read
 * as a calm, confident, wrong "nothing to compare".
 */

import {
  gatherQualityByPromptVersion,
  MIN_DECIDED_PER_VERSION,
  MIN_REJECT_RATE_DELTA,
  type QualityByPromptVersion,
} from "../intake/quality-by-prompt-version.js";
import type { HealthSection } from "./types.js";

export type QualityByPromptVersionSignal =
  | { available: true; report: QualityByPromptVersion }
  | { available: false; error: string };

/** DB tier: never throws — a failure is carried as `available: false`. */
export async function readQualityByPromptVersionSignal(params: {
  userId: string;
  workspaceId: string | null;
}): Promise<QualityByPromptVersionSignal> {
  try {
    return {
      available: true,
      report: await gatherQualityByPromptVersion(params),
    };
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** PURE: the section. */
export function summarizeQualityByPromptVersion(
  signal: QualityByPromptVersionSignal
): HealthSection {
  if (!signal.available) {
    return {
      key: "quality_by_prompt_version",
      status: "attention",
      headline:
        "Quality by prompt version could not be read — this is not a zero",
      detail: { available: false, error: signal.error },
    };
  }
  const r = signal.report;
  // A capped scan covers the most recent rows only; a verdict there can be an
  // artefact of where the cut fell. The notifier tells no one — this says so.
  const partialWindow = r.truncated.sessions || r.truncated.proposals;
  const headline =
    r.runs === 0
      ? `No intake runs in the last ${r.windowDays} days — no prompt version to compare`
      : partialWindow
        ? `Partial window — the scan hit its row cap, so ${r.groups.length} prompt version(s) across ${r.runs} intake run(s) cover the most recent rows only; no regression verdict is given`
        : r.regressions.length > 0
          ? r.regressions
              .map(
                (g) =>
                  `Prompt ${g.newer.promptVersion} is rejected ${pct(g.newer.rejectRate)} of ${g.newer.decided} reviewed vs ${pct(g.previous.rejectRate)} of ${g.previous.decided} for ${g.previous.promptVersion} (${g.engine}/${g.model ?? "no model"})`
              )
              .join("; ")
          : `${r.groups.length} prompt version(s) across ${r.runs} intake run(s); no regression at the minimum sample`;
  return {
    key: "quality_by_prompt_version",
    status: partialWindow || r.regressions.length > 0 ? "attention" : "ok",
    headline,
    detail: {
      available: true,
      ...r,
      partialWindow,
      // Never claimed off a partial scan; kept, labelled, for inspection.
      regressions: partialWindow ? [] : r.regressions,
      ...(partialWindow ? { unverifiedRegressions: r.regressions } : {}),
      thresholds: {
        minDecidedPerVersion: MIN_DECIDED_PER_VERSION,
        minRejectRateDelta: MIN_REJECT_RATE_DELTA,
      },
      denominator:
        "decided = proposals a human approved (in full or with items denied) or rejected; excludes pending, auto-approved, withdrawn, expired",
      lens: "intake runs (sessions with a run manifest) you own",
    },
  };
}
