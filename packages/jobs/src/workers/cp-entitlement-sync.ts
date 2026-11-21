/**
 * CP Entitlement Sync Worker (lane cp-link, 2026-10-23)
 *
 * Pulls two facts this pod holds from its Control Plane, authenticated by
 * `podCpAuthHeaders` (purpose "entitlement": a pod JWT once enrolled, else the
 * legacy X-Internal-Key with `?podId=`):
 *
 *   plan   GET ${CONTROL_PLANE_URL}/internal/plan — its tier and trial, derived
 *          in ONE place (synap-control-plane-api `lib/pod-plan.ts`). The answer
 *          goes to `pod_settings.settings.controlPlaneEntitlement` through
 *          `recordControlPlaneEntitlement` (`@synap/database`
 *          utils/control-plane-link.ts), read by tier-check and the trial
 *          guard.
 *   AI     GET ${CONTROL_PLANE_URL}/internal/ai-availability — its AI
 *          availability: the pod owner's billing block (state, threshold,
 *          action and the payer's link; never a plan, a price or a pack),
 *          into `pod_settings.settings.aiAvailability` through
 *          `recordPodAiAvailability`. When a pull sees AI come back, the holds
 *          that wait on it (`until: ai:available`) are woken (`hold-resume`);
 *          when the state or its mark changes, the pod's payers are told (the
 *          registered `AiAvailabilityNotifier`). A CP without the door (404,
 *          an older CP) leaves the availability UNKNOWN, recorded once per
 *          pull, never an error loop.
 *
 * A failed pull records WHY (`…Sync`) and leaves the last good answer
 * untouched: it never writes a tier or a state the CP did not state.
 *
 * Cadence: a tick every 3 minutes + once on startup. Each fact is pulled when
 * its last attempt is 15 minutes old; the AI availability on every tick while
 * a hold waits on it, so held work resumes within minutes of a top-up (the
 * apps also re-check at once, `aiAvailability.recheck`). Pull, never push:
 * the CP stopped sending tier data to pods (its `pushTierToPods` is a logged
 * no-op), and a pull heals a missed webhook or an expired trial on its own.
 *
 * Skips (one info log, nothing written) when CONTROL_PLANE_URL is unset, the
 * pod has no Control Plane link, or holds no CP credential — normal for a
 * self-hosted pod.
 */

import { z } from "zod";
import {
  db,
  listHolds,
  podCpAuthHeaders,
  readControlPlaneEntitlementSync,
  readControlPlaneLink,
  readPodAiAvailability,
  recordControlPlaneEntitlement,
  recordControlPlaneEntitlementFailure,
  recordPodAiAvailability,
  recordPodAiAvailabilityFailure,
  type ControlPlaneEntitlementSync,
  type PodAiAvailability,
  type PodAiAvailabilityChange,
} from "@synap/database";
import { getBoss } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { controlPlaneBaseUrl } from "@synap-core/core/control-plane-url";
import { HOLD_AI_MOVES } from "@synap-core/types/lifecycle";
import { HOLD_RESUME_QUEUE, type HoldResumeJobData } from "./hold-resume.js";

const logger = createLogger({ module: "cp-entitlement-sync" });

export const CP_ENTITLEMENT_SYNC_QUEUE = "cp-entitlement-sync";
/** Cron schedule — a tick every 3 minutes; each pull decides if it is due. */
export const CP_ENTITLEMENT_SYNC_CRON = "*/3 * * * *";
/**
 * A pull is due once its last attempt is this old: 15 minutes, less one for
 * the jitter of the 3-minute tick (a pull 14:58 after the last is not early).
 */
const PULL_DUE_AFTER_MS = 14 * 60_000;

/** The job's data: `force` pulls both now (the startup run). */
export interface CpEntitlementSyncJobData {
  force?: boolean;
}

/** The CP's answer (`PodPlan`, CP lib/pod-plan.ts). */
const planSchema = z.object({
  podId: z.string().min(1),
  tier: z.string().min(1).nullable(),
  status: z.string().min(1).nullable(),
  trialEnd: z.string().datetime({ offset: true }).nullable(),
  lab: z.boolean(),
});

/**
 * The CP's AI availability (`GET /internal/ai-availability`, CP lib
 * billing-state.ts). Only the fields the availability model reads are KEPT
 * (zod strips the rest): the pod never stores the account, plan, balance or
 * packs. `actionUrl` is optional so a CP from before it answers too.
 */
const aiAvailabilitySchema = z.object({
  podId: z.string().min(1),
  checkedAt: z.string().datetime({ offset: true }),
  billing: z.union([
    z.object({ readFailed: z.literal(true) }),
    z.object({
      readFailed: z.literal(false),
      state: z.enum([
        "ok",
        "low",
        "empty",
        "not_entitled",
        "suspended",
        "unmetered",
      ]),
      threshold: z.number().nullable(),
      dismissKey: z.string().nullable(),
      resetsAt: z.string().nullable(),
      viewerRole: z.enum(["pod_owner", "owner", "admin", "member"]),
      canTopUp: z.boolean(),
      action: z.enum(["top_up", "upgrade", "ask_admin", "fix_payment", "none"]),
      actionUrl: z
        .string()
        .url()
        .refine((u) => u.startsWith("https://"), "an https page")
        .nullable()
        .optional()
        .transform((u) => u ?? null),
    }),
  ]),
});

/**
 * Told when a pull changed the AI availability (`@synap/api`
 * `notifyAiAvailabilityChange`: the payers' notification). `@synap/api`
 * depends on this package, so apps/api fills the slot at boot.
 */
export type AiAvailabilityNotifier = (
  change: PodAiAvailabilityChange
) => Promise<void>;

let aiAvailabilityNotifier: AiAvailabilityNotifier | null = null;

export function registerAiAvailabilityNotifier(
  fn: AiAvailabilityNotifier
): void {
  aiAvailabilityNotifier = fn;
}

let loggedEnvSkip = false;
let loggedLinkSkip = false;
let loggedCredentialSkip = false;

/** Who the pull calls, and with what credential. */
interface CpCaller {
  cpUrl: string;
  podId: string;
  headers: Record<string, string>;
}

type FailedOutcome = Exclude<ControlPlaneEntitlementSync["outcome"], "ok">;

/** Read failed: a reason to record. Null: nothing to pull from (logged once). */
async function resolveCaller(): Promise<
  CpCaller | { failed: FailedOutcome; message: string } | null
> {
  const cpUrl = controlPlaneBaseUrl();
  if (!cpUrl) {
    if (!loggedEnvSkip) {
      logger.info(
        "CONTROL_PLANE_URL unset — plan sync disabled (normal for self-hosted pods)"
      );
      loggedEnvSkip = true;
    }
    return null;
  }

  const link = await readControlPlaneLink();
  if (!link) {
    if (!loggedLinkSkip) {
      logger.info(
        "No Control Plane link — pod is not registered yet; skipping plan sync"
      );
      loggedLinkSkip = true;
    }
    return null;
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
    return {
      failed: "refused",
      message: "This pod's Control Plane credential cannot be used.",
    };
  }
  if (!auth) {
    if (!loggedCredentialSkip) {
      logger.info(
        "No CP credential (pod key or SYNAP_POD_INTERNAL_KEY) — plan sync disabled"
      );
      loggedCredentialSkip = true;
    }
    return null;
  }
  return { cpUrl, podId: link.podId, headers: auth.headers };
}

/**
 * GET one of the CP's pod doors. The legacy fleet key names no pod: it
 * asserts the pod by `podId`.
 */
async function getFromCp(
  caller: CpCaller,
  path: string,
  what: string
): Promise<
  { ok: true; body: unknown } | { ok: false; failed: FailedOutcome; message: string }
> {
  const url = `${caller.cpUrl}${path}?podId=${encodeURIComponent(caller.podId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: caller.headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn({ err, what }, "CP unreachable — pull deferred");
    return {
      ok: false,
      failed: "unreachable",
      message: "The Control Plane could not be reached.",
    };
  }
  if (!res.ok) {
    const outcome: FailedOutcome =
      res.status === 401 || res.status === 403
        ? "refused"
        : res.status === 404
          ? "unsupported"
          : "unreachable";
    logger.warn({ status: res.status, outcome, what }, "CP did not answer");
    return {
      ok: false,
      failed: outcome,
      message:
        outcome === "refused"
          ? `The Control Plane refused this pod's request (HTTP ${res.status}).`
          : outcome === "unsupported"
            ? `The Control Plane does not serve this pod's ${what} (HTTP 404).`
            : `The Control Plane answered HTTP ${res.status}.`,
    };
  }
  return { ok: true, body: await res.json().catch(() => null) };
}

async function pullPlan(caller: CpCaller): Promise<void> {
  const got = await getFromCp(caller, "/internal/plan", "plan");
  if (!got.ok) {
    await recordControlPlaneEntitlementFailure(got.failed, got.message);
    return;
  }
  const parsed = planSchema.safeParse(got.body);
  if (!parsed.success || parsed.data.podId !== caller.podId) {
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

/** The outcome of one AI availability pull, for the re-check door. */
export type AiAvailabilityPull =
  | { outcome: "ok"; availability: PodAiAvailability }
  | { outcome: FailedOutcome | "not_linked"; message: string };

async function pullAiAvailability(
  caller: CpCaller,
  now: Date
): Promise<AiAvailabilityPull> {
  const got = await getFromCp(
    caller,
    "/internal/ai-availability",
    "AI availability"
  );
  if (!got.ok) {
    await recordPodAiAvailabilityFailure(got.failed, got.message, now);
    return { outcome: got.failed, message: got.message };
  }
  const parsed = aiAvailabilitySchema.safeParse(got.body);
  if (!parsed.success || parsed.data.podId !== caller.podId) {
    logger.warn(
      { shapeValid: parsed.success },
      "CP AI availability answer is not for this pod"
    );
    const message =
      "The Control Plane's answer is not this pod's AI availability.";
    await recordPodAiAvailabilityFailure("invalid", message, now);
    return { outcome: "invalid", message };
  }
  const { billing, checkedAt } = parsed.data;
  const change = await recordPodAiAvailability({ billing, checkedAt }, now);
  logger.info(
    {
      state: billing.readFailed ? "read_failed" : billing.state,
      becameAvailable: change.becameAvailable,
    },
    "Pulled this pod's AI availability from the CP"
  );
  if (change.becameAvailable) {
    // The holds that wait on AI are checked now, not at the hourly sweep.
    await getBoss().send(HOLD_RESUME_QUEUE, {
      devFact: HOLD_AI_MOVES,
    } satisfies HoldResumeJobData);
  }
  if (aiAvailabilityNotifier) {
    await aiAvailabilityNotifier(change).catch((err) =>
      logger.warn({ err }, "AI availability notice failed — the pull stands")
    );
  } else {
    logger.warn(
      "AI availability notifier not registered — apps/api must call registerAiAvailabilityNotifier() at boot"
    );
  }
  return { outcome: "ok", availability: change.current };
}

const isDue = (
  sync: ControlPlaneEntitlementSync | null,
  now: Date
): boolean =>
  !sync ||
  !(now.getTime() - Date.parse(sync.lastAttemptAt) < PULL_DUE_AFTER_MS);

/** Called by the cron tick (no data) and the startup enqueue (`force`). */
export async function handleCpEntitlementSync(
  data: CpEntitlementSyncJobData = {},
  now: Date = new Date()
): Promise<void> {
  let plan = true;
  let ai = true;
  if (!data.force) {
    const [planSync, aiRead, aiHolds] = await Promise.all([
      readControlPlaneEntitlementSync(),
      readPodAiAvailability(),
      listHolds(
        db,
        { awaiting: { subjectType: "ai", subjectId: "available" } },
        now
      ),
    ]);
    plan = isDue(planSync, now);
    // A CP that has no availability door (404) is asked again at the plan's
    // pace, never every tick: a hold cannot make an older CP answer.
    ai =
      (aiHolds.length > 0 && aiRead.sync?.outcome !== "unsupported") ||
      isDue(aiRead.sync, now);
  }
  if (!plan && !ai) return;

  const caller = await resolveCaller();
  if (!caller) return;
  if ("failed" in caller) {
    if (plan)
      await recordControlPlaneEntitlementFailure(caller.failed, caller.message);
    if (ai)
      await recordPodAiAvailabilityFailure(caller.failed, caller.message, now);
    return;
  }
  if (plan) await pullPlan(caller);
  if (ai) await pullAiAvailability(caller, now);
}

/**
 * Pull the AI availability NOW (the re-check door, `aiAvailability.recheck`:
 * an app calls it right after a successful top-up, so held work resumes in
 * seconds). `not_linked` = this pod has nothing to pull from.
 */
export async function pullAiAvailabilityNow(
  now: Date = new Date()
): Promise<AiAvailabilityPull> {
  const caller = await resolveCaller();
  if (!caller) {
    return {
      outcome: "not_linked",
      message: "This pod is not linked to a Control Plane.",
    };
  }
  if ("failed" in caller) {
    await recordPodAiAvailabilityFailure(caller.failed, caller.message, now);
    return { outcome: caller.failed, message: caller.message };
  }
  return pullAiAvailability(caller, now);
}
