/**
 * THE COMPUTE CONTRACT — what the pod requires of a compute start and a
 * compute release, whoever the provider (plan a640c5bb B3, ticket 5f3c3a7d;
 * founder decisions of 18 Nov 2026).
 *
 * Two intents (migration 0429), grouped with run_external_job and
 * fetch_record in the `compute` need (0431):
 *
 *   provision_compute  parameters `ttlMinutes` (whole minutes, > 0) and
 *                      `maxSpendCents` (whole cents, > 0) are REQUIRED, plus
 *                      the provider's own (size, image, region…). The verb
 *                      DECLARES the release verb the pod runs at the TTL
 *                      (`metadata.compute.releaseVerb`), and its result
 *                      carries the provider's id of the machine as
 *                      `resourceId` (a declarative verb shapes it:
 *                      `responseShape.scalar.resourceId`).
 *   release_compute    parameters `resourceId` and `mode` (`stop` keeps the
 *                      machine and usually its disk billing; `destroy` ends
 *                      it). The verb DECLARES the modes it serves
 *                      (`metadata.compute.modes`); a mode it does not serve is
 *                      refused, so a destroy verb never runs for a stop.
 *
 * Read by BOTH run doors: `executeCapability` (before the gate, so a start
 * without its TTL or maximum files nothing) and the one post-gate runner
 * `runResolvedSkill` (so an approved proposal is checked again). PURE: no
 * database, no clock.
 */
import { declaredCompute } from "../capabilities/capability-drift.js";

export const PROVISION_COMPUTE_INTENT = "provision_compute";
export const RELEASE_COMPUTE_INTENT = "release_compute";

/** Sanity bound on a TTL: one year, in minutes. */
export const COMPUTE_TTL_MAX_MINUTES = 525_600;
/** Sanity bound on one start's maximum (fits the integer column). */
export const COMPUTE_SPEND_MAX_CENTS = 1_000_000_000;

export type ComputeReleaseMode = "stop" | "destroy";

export interface ComputeStart {
  kind: "start";
  ttlMinutes: number;
  maxSpendCents: number;
  /** The release_compute verb run in mode destroy at the TTL. */
  releaseVerb: string;
}

export interface ComputeRelease {
  kind: "release";
  resourceId: string;
  mode: ComputeReleaseMode;
}

export type ComputeRun =
  | { kind: "none" }
  | ComputeStart
  | ComputeRelease
  /** The run must not happen; `message` says what to send instead. */
  | { kind: "refused"; message: string };

interface ComputeVerb {
  name: string;
  intent: string | null;
  metadata: unknown;
}

/** A whole number in [1, max], from a number or a string of digits. */
function wholeNumber(value: unknown, max: number): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

function metadataOf(verb: ComputeVerb): Record<string, unknown> | null {
  return verb.metadata && typeof verb.metadata === "object"
    ? (verb.metadata as Record<string, unknown>)
    : null;
}

/**
 * What the compute contract says about this run of this verb: nothing (not a
 * compute verb), a start, a release, or a refusal with its reason.
 */
export function readComputeRun(
  verb: ComputeVerb,
  parameters: Record<string, unknown> | undefined
): ComputeRun {
  const params = parameters ?? {};
  if (verb.intent === PROVISION_COMPUTE_INTENT) {
    const releaseVerb = declaredCompute(metadataOf(verb))?.releaseVerb;
    if (!releaseVerb) {
      return {
        kind: "refused",
        message: `Verb "${verb.name}" starts compute but declares no release verb (metadata.compute.releaseVerb), so the pod could not release it at its time to live. Nothing was started.`,
      };
    }
    const ttlMinutes = wholeNumber(params.ttlMinutes, COMPUTE_TTL_MAX_MINUTES);
    const maxSpendCents = wholeNumber(
      params.maxSpendCents,
      COMPUTE_SPEND_MAX_CENTS
    );
    const missing = [
      ttlMinutes === null
        ? `ttlMinutes (whole minutes, 1 to ${COMPUTE_TTL_MAX_MINUTES})`
        : null,
      maxSpendCents === null
        ? "maxSpendCents (whole cents, at least 1: the time to live times the price)"
        : null,
    ].filter((m): m is string => m !== null);
    if (missing.length > 0) {
      return {
        kind: "refused",
        message: `Every compute start needs a time to live and a spend maximum. Send ${missing.join(" and ")} with "${verb.name}". Nothing was started.`,
      };
    }
    return {
      kind: "start",
      ttlMinutes: ttlMinutes!,
      maxSpendCents: maxSpendCents!,
      releaseVerb,
    };
  }
  if (verb.intent === RELEASE_COMPUTE_INTENT) {
    const modes = declaredCompute(metadataOf(verb))?.modes;
    const raw = params.resourceId;
    const resourceId =
      typeof raw === "string" && raw.trim()
        ? raw.trim()
        : typeof raw === "number" && Number.isFinite(raw)
          ? String(raw)
          : null;
    const mode = params.mode;
    if (!resourceId) {
      return {
        kind: "refused",
        message: `Send resourceId (the provider's id of the machine) with "${verb.name}". Nothing was released.`,
      };
    }
    if (mode !== "stop" && mode !== "destroy") {
      return {
        kind: "refused",
        message: `Send mode "stop" or "destroy" with "${verb.name}". Nothing was released.`,
      };
    }
    if (!modes?.includes(mode)) {
      return {
        kind: "refused",
        message: `Verb "${verb.name}" does not ${mode} a machine (it serves ${modes?.join(", ") ?? "no declared mode: metadata.compute.modes"}). Nothing was released.`,
      };
    }
    return { kind: "release", resourceId, mode };
  }
  return { kind: "none" };
}

/** "45 min", "2 h", "2 h 30 min", "3 days". */
export function describeComputeDuration(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The review card's line for a start: what starts, for how long, at most
 * what, and that it ends by itself (founder, 18 Nov 2026: approving the start
 * approves the destroy at its time to live). The amount is in the
 * provider's billing currency, which the pod does not know.
 */
export function describeComputeStart(
  verbLabel: string,
  start: Pick<ComputeStart, "ttlMinutes" | "maxSpendCents">
): string {
  const duration = describeComputeDuration(start.ttlMinutes);
  const amount = (start.maxSpendCents / 100).toFixed(2);
  return `Start a cloud machine (${verbLabel}) for ${duration}, spending at most ${amount} in the provider's currency. It is destroyed automatically after ${duration}.`;
}

/** The provider's id of the machine in a start's result (`resourceId`). */
export function resourceIdOf(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const raw = (result as Record<string, unknown>).resourceId;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}
