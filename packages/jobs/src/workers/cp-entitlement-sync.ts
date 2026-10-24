/**
 * CP Entitlement Sync Worker (lane cp-link, 2026-10-23)
 *
 * Pulls the plan this pod enforces — its tier and trial — from its Control
 * Plane: GET ${CONTROL_PLANE_URL}/internal/plan, authenticated by
 * `podCpAuthHeaders` (purpose "entitlement": a pod JWT once enrolled, else the
 * legacy X-Internal-Key with `?podId=`). The CP derives it in ONE place
 * (synap-control-plane-api `lib/pod-plan.ts`).
 *
 * The answer goes to `pod_settings.settings.controlPlaneEntitlement` through
 * `recordControlPlaneEntitlement` (`@synap/database` utils/control-plane-link.ts),
 * read by tier-check and the trial guard. A failed pull records WHY in
 * `controlPlaneEntitlementSync` and leaves the last good plan untouched: it
 * never writes a tier the CP did not state.
 *
 * Runs every 15 minutes + once on startup. Pull, never push: the CP stopped
 * sending tier data to pods (its `pushTierToPods` is a logged no-op), and a
 * pull heals a missed webhook or an expired trial on its own.
 *
 * Skips (one info log, nothing written) when CONTROL_PLANE_URL is unset, the
 * pod has no Control Plane link, or holds no CP credential — normal for a
 * self-hosted pod.
 */

import { z } from "zod";
import {
  podCpAuthHeaders,
  readControlPlaneLink,
  recordControlPlaneEntitlement,
  recordControlPlaneEntitlementFailure,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "cp-entitlement-sync" });

export const CP_ENTITLEMENT_SYNC_QUEUE = "cp-entitlement-sync";
/** Cron schedule — every 15 minutes. */
export const CP_ENTITLEMENT_SYNC_CRON = "*/15 * * * *";

/** The CP's answer (`PodPlan`, CP lib/pod-plan.ts). */
const planSchema = z.object({
  podId: z.string().min(1),
  tier: z.string().min(1).nullable(),
  status: z.string().min(1).nullable(),
  trialEnd: z.string().datetime({ offset: true }).nullable(),
  lab: z.boolean(),
});

let loggedEnvSkip = false;
let loggedLinkSkip = false;
let loggedCredentialSkip = false;

/** Called by the cron tick and the startup enqueue. */
export async function handleCpEntitlementSync(): Promise<void> {
  const cpUrl = (process.env.CONTROL_PLANE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!cpUrl) {
    if (!loggedEnvSkip) {
      logger.info(
        "CONTROL_PLANE_URL unset — plan sync disabled (normal for self-hosted pods)"
      );
      loggedEnvSkip = true;
    }
    return;
  }

  const link = await readControlPlaneLink();
  if (!link) {
    if (!loggedLinkSkip) {
      logger.info(
        "No Control Plane link — pod is not registered yet; skipping plan sync"
      );
      loggedLinkSkip = true;
    }
    return;
  }

  let auth: Awaited<ReturnType<typeof podCpAuthHeaders>>;
  try {
    auth = await podCpAuthHeaders({
      purpose: "entitlement",
      legacy: "internal-key",
      controlPlaneUrl: cpUrl,
    });
  } catch (err) {
    logger.warn(
      { err },
      "This pod's CP credential cannot be used — plan sync deferred"
    );
    await recordControlPlaneEntitlementFailure(
      "refused",
      "This pod's Control Plane credential cannot be used."
    );
    return;
  }
  if (!auth) {
    if (!loggedCredentialSkip) {
      logger.info(
        "No CP credential (pod key or SYNAP_POD_INTERNAL_KEY) — plan sync disabled"
      );
      loggedCredentialSkip = true;
    }
    return;
  }

  // The legacy fleet key names no pod: it asserts the pod by `podId`.
  const url = `${cpUrl}/internal/plan?podId=${encodeURIComponent(link.podId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: auth.headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn({ err }, "CP unreachable — plan sync deferred");
    await recordControlPlaneEntitlementFailure(
      "unreachable",
      "The Control Plane could not be reached."
    );
    return;
  }

  if (!res.ok) {
    const outcome =
      res.status === 401 || res.status === 403
        ? "refused"
        : res.status === 404
          ? "unsupported"
          : "unreachable";
    logger.warn({ status: res.status, outcome }, "CP did not answer the plan");
    await recordControlPlaneEntitlementFailure(
      outcome,
      outcome === "refused"
        ? `The Control Plane refused this pod's request (HTTP ${res.status}).`
        : outcome === "unsupported"
          ? "The Control Plane does not serve this pod's plan (HTTP 404)."
          : `The Control Plane answered HTTP ${res.status}.`
    );
    return;
  }

  const parsed = planSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success || parsed.data.podId !== link.podId) {
    logger.warn(
      { shapeValid: parsed.success },
      "CP plan answer is not a plan for this pod"
    );
    await recordControlPlaneEntitlementFailure(
      "invalid",
      "The Control Plane's answer is not a plan for this pod."
    );
    return;
  }

  const { tier, status, trialEnd, lab } = parsed.data;
  await recordControlPlaneEntitlement({ tier, status, trialEnd, lab });
  logger.info({ tier, status, lab }, "Pulled this pod's plan from the CP");
}
