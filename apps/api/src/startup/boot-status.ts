/**
 * Boot-time state surfaced on `GET /status/release` — conversions + the
 * system-profile seeder. Pure builders + the single in-process holder for the
 * seeder result, so the route and its tests share one projection.
 *
 * "Not measured" is kept distinct from "measured, nothing found": `checkedAt`
 * and `pending` are `null` until the boot pass actually ran (e.g.
 * SYNAP_SKIP_CONVERSIONS=1), never `[]`.
 */

import type {
  EnsureSystemProfilesResult,
  RunOptions,
  RunSummary,
} from "@synap/database";

/** Exactly how pod boot invokes the conversion engine. */
export const BOOT_CONVERSION_OPTIONS: RunOptions = {
  dryRun: false,
  destructiveTail: false,
  deferDestructive: true,
  // Manifest ops flagged `deferAtBoot` (e.g. crm.deal-stage.commercial-fold)
  // are SKIPPED here — a data cutover must never auto-apply at deploy.
  skipDeferred: true,
};

export interface PendingConversion {
  opKey: string;
  op: string;
  slug: string | null;
  reason: "destructive-tail" | "defer-at-boot" | "unknown";
}

export interface ConversionsBootState {
  degraded: boolean;
  failures: Array<{
    opKey: string;
    op: string;
    severity: string;
    error: string;
  }>;
  pending: PendingConversion[] | null;
  checkedAt: number;
}

export const UNCHECKED_CONVERSIONS_STATE: ConversionsBootState = {
  degraded: false,
  failures: [],
  pending: null,
  checkedAt: 0,
};

/**
 * Project a boot summary into the state `/status/release` reports. Call it for
 * EVERY completed boot pass — not only a degraded one — so `checkedAt` and
 * `pending` reflect a clean boot too.
 */
export function conversionsBootStateFromSummary(
  summary: RunSummary,
  now: number = Date.now()
): ConversionsBootState {
  const advisory = summary.results.filter(
    (r) => r.status === "error" && r.severity === "advisory"
  );
  return {
    degraded: advisory.length > 0,
    failures: advisory.map((r) => ({
      opKey: r.opKey,
      op: r.op,
      severity: r.severity ?? "advisory",
      error: r.error ?? "unknown error",
    })),
    pending: summary.results
      .filter((r) => r.status === "deferred")
      .map((r) => ({
        opKey: r.opKey,
        op: r.op,
        slug: r.slug ?? null,
        // The engine stamps a reason on every deferral. A missing one means the
        // engine changed: report "unknown" rather than guess the operator path,
        // and never throw — this runs inside the boot gate, where a throw
        // would exit(1) the pod over a visibility field.
        reason: r.deferReason ?? "unknown",
      })),
    checkedAt: now,
  };
}

/** The `conversions` section of `/status/release`. */
export function conversionsStatusSection(state: ConversionsBootState) {
  return {
    degraded: state.degraded,
    failures: state.failures,
    pending: state.pending,
    checkedAt: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
  };
}

// ── System-profile seeder ────────────────────────────────────────────────────
// `ensureSystemProfiles()` catches its own failure into `{status:"error"}`, so
// the boot hook must hand its result here for the route to see it.
let systemProfilesBootResult:
  | { result: EnsureSystemProfilesResult; at: number }
  | { thrown: string; at: number }
  | null = null;

export function recordSystemProfilesBootResult(
  outcome: EnsureSystemProfilesResult | { thrown: unknown },
  now: number = Date.now()
): void {
  systemProfilesBootResult =
    "thrown" in outcome
      ? {
          thrown:
            outcome.thrown instanceof Error
              ? outcome.thrown.message
              : String(outcome.thrown),
          at: now,
        }
      : { result: outcome, at: now };
}

/** The `systemProfiles` section of `/status/release`. */
export function systemProfilesStatusSection() {
  const s = systemProfilesBootResult;
  if (!s) return { status: null, error: null, checkedAt: null };
  const checkedAt = new Date(s.at).toISOString();
  if ("thrown" in s)
    return { status: "error" as const, error: s.thrown, checkedAt };
  return {
    status: s.result.status,
    error:
      s.result.status === "error" ? (s.result.error ?? s.result.message) : null,
    checkedAt,
  };
}

/** Test-only: reset the in-process holder. */
export function __resetSystemProfilesBootResultForTest(): void {
  systemProfilesBootResult = null;
}
