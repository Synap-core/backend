/**
 * Feed query planning — asks the Control Plane relay to expand an archetype +
 * criteria into concrete fetch targets.
 *
 * The relay key is the pod's ONE current CP credential (`readCpRelayCredential`),
 * never a copy baked into a source-config row: the CP rotates by delivering a
 * fresh row, so a per-row copy goes stale while the pod key stays live.
 *
 * The outcome is typed so "no queries were planned" and "planning failed" are
 * different facts: a failure never reads as an empty plan.
 */

import {
  CpRelayVaultUnresolvedError,
  readCpRelayCredential,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "feed-query-plan" });

/** A concrete fetch target produced by the CP query planner. */
export interface DerivedQuery {
  upstreamType: string;
  config: Record<string, unknown>;
  label: string;
  rationale?: string;
}

export type FeedQueryPlanFailure =
  | "relay-credential-missing"
  | "relay-credential-unresolved"
  | "credential-read-failed"
  | "planner-failed";

export type FeedQueryPlan =
  /** The planner answered; `queries` may legitimately be empty. */
  | { status: "planned"; queries: DerivedQuery[] }
  /** No Control Plane is configured, so there is no planner to ask. */
  | { status: "unavailable" }
  | { status: "failed"; reason: FeedQueryPlanFailure; message: string };

export async function deriveFeedQueries(
  archetypeConfig: { config: unknown },
  archetype: string,
  criteria: string | undefined
): Promise<FeedQueryPlan> {
  const raw = (archetypeConfig.config ?? {}) as Record<string, unknown>;
  // Source-config rows don't always carry the CP URL.
  const relayUrl =
    (raw.relayUrl as string | undefined) ??
    process.env.CP_URL ??
    process.env.CONTROL_PLANE_URL;
  if (!relayUrl) return { status: "unavailable" };

  let relayKey: string;
  try {
    const credential = await readCpRelayCredential();
    if (!credential) {
      return {
        status: "failed",
        reason: "relay-credential-missing",
        message:
          "This pod holds no relay key from its control plane. Rotate the pod's relay key from the control plane.",
      };
    }
    relayKey = credential.key;
  } catch (err) {
    if (err instanceof CpRelayVaultUnresolvedError) {
      return {
        status: "failed",
        reason: "relay-credential-unresolved",
        message:
          "This pod's relay key cannot be read from its vault. Rotate the pod's relay key from the control plane so it re-delivers a readable key.",
      };
    }
    return {
      status: "failed",
      reason: "credential-read-failed",
      message: `Could not read this pod's relay key: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const res = await fetch(
      `${relayUrl.replace(/\/$/, "")}/api/sources/plan-queries`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${relayKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ archetype, criteria }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!res.ok) {
      logger.warn(
        { archetype, status: res.status },
        "plan-queries returned non-OK"
      );
      return {
        status: "failed",
        reason: "planner-failed",
        message: `The control plane query planner answered ${res.status}.`,
      };
    }
    const json = (await res.json()) as unknown;
    const queries = (json as { queries?: unknown } | null)?.queries;
    if (!Array.isArray(queries)) {
      return {
        status: "failed",
        reason: "planner-failed",
        message: "The control plane query planner returned no query list.",
      };
    }
    return { status: "planned", queries: queries as DerivedQuery[] };
  } catch (err) {
    logger.warn({ err, archetype }, "Failed to derive feed queries");
    return {
      status: "failed",
      reason: "planner-failed",
      message: `The control plane query planner could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
