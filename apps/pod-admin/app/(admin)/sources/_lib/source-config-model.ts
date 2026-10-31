/**
 * A pod-level source config, shaped for its drawer. PURE: the
 * `sourceConfigs.list` row and the `sourceConfigs.testConnection` answer in,
 * words out — tested at the seam.
 *
 * The test line says exactly what the probe returned. A probe that answered
 * `ok: false` is a FAILED PROBE (the source did not answer, with its own
 * reason); a call that threw never reached the probe (`couldNotRun`). The two
 * are different facts and are worded apart, and neither is ever shown as a
 * success.
 */

import type { TFunction } from "@synap-core/types/i18n";
import type { en } from "./copy";

export type SourceT = TFunction<typeof en>;

/** One row of `sourceConfigs.list` — only what the drawer reads. */
export interface SourceConfigRow {
  id: string;
  providerType: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  workspaceId?: string | null;
  config?: Record<string, unknown> | null;
  lastTestedAt?: Date | string | null;
  lastTestStatus?: string | null;
  lastTestError?: string | null;
  createdAt?: Date | string | null;
}

/** What `sourceConfigs.testConnection` returns. */
export interface TestResult {
  ok: boolean;
  error?: string;
  sampleCount?: number;
}

export type TestOutcome = { kind: "ok" | "error"; message: string };

/** The probe's answer, in the probe's own words. */
export function testOutcome(result: TestResult, t: SourceT): TestOutcome {
  if (result.ok) {
    return {
      kind: "ok",
      message:
        typeof result.sampleCount === "number"
          ? t("test.okSample", { n: result.sampleCount })
          : t("test.ok"),
    };
  }
  const why = result.error?.trim();
  return {
    kind: "error",
    message: why ? t("test.error", { why }) : t("test.errorNoReason"),
  };
}

/** A call that threw before the probe answered. */
export function testCouldNotRun(message: string, t: SourceT): TestOutcome {
  return { kind: "error", message: t("test.couldNotRun", { why: message }) };
}

/** Where a source reads from: the whole pod, or one space (short id). */
export function scopeLabel(row: SourceConfigRow, t: SourceT): string {
  return row.workspaceId
    ? t("scope.space", { id: row.workspaceId.slice(0, 8) })
    : t("scope.pod");
}

/**
 * The last PERSISTED test, from the row: never tested, passed, or failed
 * (with its reason). `when` is the caller's relative time.
 */
export function lastTestLine(
  row: SourceConfigRow,
  when: string,
  t: SourceT
): string {
  if (!row.lastTestedAt || !row.lastTestStatus) return t("lastTest.never");
  if (row.lastTestStatus === "ok") return t("lastTest.ok", { when });
  const why = row.lastTestError?.trim();
  return why
    ? t("lastTest.errorWhy", { when, why })
    : t("lastTest.error", { when });
}
