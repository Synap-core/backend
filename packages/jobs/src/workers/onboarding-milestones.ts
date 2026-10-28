/**
 * Onboarding milestones → Control Plane (onboarding plan v1 §5, slice A9)
 *
 * A cloud pod tells its Control Plane how far its owner got through the start
 * (`/start`, plan §1), so the CP can measure the funnel and send the one
 * reminder email at the time the person picked (S7 `nextReturn`).
 *
 * WHAT IS SENT — and nothing else: milestone ids, their timestamps, and four
 * enum properties (`slug`, `viewType`, `path`, `arm`), plus `nextReturn` as a
 * timestamp and a session id. Never content, names or text: the start values
 * also hold the person's own words (`cloud.workingOn`), and the payload is
 * BUILT field by field from an allow-list, never copied from them. A
 * property that is not a short token is dropped, not sent.
 *
 * WHEN NOTHING IS SENT (one info log, nothing written):
 *   - the pod has no Control Plane link — a self-hosted pod never sends
 *     (research principle 24);
 *   - the pod admin switched sharing off (Settings › Privacy; ON by default,
 *     founder OQ3);
 *   - the pod holds no pod key: the CP route accepts only a pod-signed token,
 *     never the fleet-shared legacy key;
 *   - there is no start journey, or nothing changed since the CP last
 *     accepted the payload (its digest is kept in pod_settings).
 *
 * POST ${CP}/internal/onboarding-milestones, purpose "onboarding". The CP
 * stores each milestone once per (pod, id): a re-send is harmless.
 * Runs every 15 minutes + once on startup.
 */

import crypto from "node:crypto";
import {
  podCpAuthHeaders,
  readControlPlaneLink,
  readOnboardingMilestoneFacts,
  readOnboardingMilestonesSharing,
  readOnboardingMilestonesSync,
  recordOnboardingMilestonesSent,
  type OnboardingMilestoneFacts,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "onboarding-milestones" });

export const ONBOARDING_MILESTONES_QUEUE = "onboarding-milestones";
/** Cron schedule — every 15 minutes. */
export const ONBOARDING_MILESTONES_CRON = "*/15 * * * *";

/** The milestone ids (plan §5), in funnel order. */
export const ONBOARDING_MILESTONE_IDS = [
  "console_opened",
  "intent_set",
  "view_chosen",
  "path_chosen",
  "setup_proposed",
  "setup_approved",
  "setup_rejected",
  "setup_undone",
  "agent_seen",
  "first_session_created",
  "first_agent_proposal",
  "first_agent_approval",
  "done",
  "returned_week2",
] as const;
export type OnboardingMilestoneId = (typeof ONBOARDING_MILESTONE_IDS)[number];

export interface OnboardingMilestone {
  id: OnboardingMilestoneId;
  at: string;
  slug?: string;
  viewType?: string;
  path?: string;
  arm?: string;
}

export interface OnboardingMilestonesPayload {
  v: 1;
  milestones: OnboardingMilestone[];
  nextReturn: { at: string; sessionId: string } | null;
}

/** A short lowercase token (a template slug, a view type, an arm). */
const TOKEN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const token = (v: unknown): string | undefined =>
  typeof v === "string" && TOKEN.test(v) ? v : undefined;
const iso = (v: unknown): string | null => {
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * The milestones the facts prove, each with its time. Pure. A milestone whose
 * time cannot be read is left out, never sent with a guessed one.
 */
export function deriveOnboardingMilestones(
  facts: OnboardingMilestoneFacts
): OnboardingMilestone[] {
  const start = facts.journey.start;
  const intent = rec(start.intent);
  const view = rec(start.view);
  const path = rec(start.path);
  const setup = rec(start.setup);
  const agent = rec(start.agent);
  const firstSession = rec(start.firstSession);
  // §2.2 keeps the arms at `start.experiments`; A5's intent step copies them
  // under `start.cloud.experiments`. Only the arm tokens are read from either.
  const experiments = rec(start.experiments ?? rec(start.cloud).experiments);
  const proposal = facts.setupProposal;

  const candidates: Array<
    [OnboardingMilestoneId, unknown, Omit<OnboardingMilestone, "id" | "at">?]
  > = [
    ["console_opened", facts.journey.offeredAt],
    ["intent_set", intent.at, { slug: token(intent.slug) }],
    [
      "view_chosen",
      view.at,
      { viewType: token(view.type), arm: token(experiments.viewStep) },
    ],
    [
      "path_chosen",
      path.at,
      { path: token(path.kind), arm: token(experiments.setupPath) },
    ],
    ["setup_proposed", setup.at],
    [
      "setup_approved",
      proposal?.status === "approved" ? proposal.reviewedAt : null,
    ],
    [
      "setup_rejected",
      proposal?.status === "rejected" ? proposal.reviewedAt : null,
    ],
    ["setup_undone", proposal?.undoneAt ?? null],
    ["agent_seen", agent.at],
    [
      "first_session_created",
      firstSession.at,
      { arm: token(experiments.firstSessionGovernance) },
    ],
    ["first_agent_proposal", facts.firstAgentProposalAt],
    ["first_agent_approval", facts.firstAgentApprovalAt],
    [
      "done",
      facts.journey.status === "completed" ? facts.journey.completedAt : null,
    ],
    ["returned_week2", facts.week2ActivityAt],
  ];

  const out: OnboardingMilestone[] = [];
  for (const [id, rawAt, props] of candidates) {
    const at = iso(rawAt);
    if (!at) continue;
    const m: OnboardingMilestone = { id, at };
    for (const [k, v] of Object.entries(props ?? {})) {
      if (v !== undefined) (m as unknown as Record<string, string>)[k] = v;
    }
    out.push(m);
  }
  return out;
}

/** The whole body the CP receives. Pure. */
export function buildOnboardingMilestonesPayload(
  facts: OnboardingMilestoneFacts
): OnboardingMilestonesPayload {
  const next = rec(facts.journey.start.nextReturn);
  const at = iso(next.at);
  const sessionId =
    typeof next.sessionId === "string" && UUID.test(next.sessionId)
      ? next.sessionId
      : null;
  return {
    v: 1,
    milestones: deriveOnboardingMilestones(facts),
    nextReturn: at && sessionId ? { at, sessionId } : null,
  };
}

let loggedLinkSkip = false;
let loggedSwitchSkip = false;
let loggedCredentialSkip = false;

/** Called by the cron tick and the startup enqueue. */
export async function handleOnboardingMilestones(): Promise<void> {
  const link = await readControlPlaneLink();
  const cpUrl = (link?.url ?? process.env.CONTROL_PLANE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!link || !cpUrl) {
    if (!loggedLinkSkip) {
      logger.info(
        "No Control Plane link — onboarding milestones are not sent (normal for self-hosted pods)"
      );
      loggedLinkSkip = true;
    }
    return;
  }

  if (!(await readOnboardingMilestonesSharing()).enabled) {
    if (!loggedSwitchSkip) {
      logger.info("Milestone sharing is switched off — nothing is sent");
      loggedSwitchSkip = true;
    }
    return;
  }

  const facts = await readOnboardingMilestoneFacts();
  if (!facts) return;
  const payload = buildOnboardingMilestonesPayload(facts);
  const body = JSON.stringify(payload);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  if ((await readOnboardingMilestonesSync())?.digest === digest) return;

  let auth: Awaited<ReturnType<typeof podCpAuthHeaders>>;
  try {
    auth = await podCpAuthHeaders({
      purpose: "onboarding",
      legacy: "internal-key",
      controlPlaneUrl: cpUrl,
    });
  } catch (err) {
    logger.warn(
      { err },
      "This pod's CP credential cannot be used — milestones deferred"
    );
    return;
  }
  // The CP route refuses the fleet-shared legacy key: send only when signed.
  if (!auth || auth.via !== "pod-jwt") {
    if (!loggedCredentialSkip) {
      logger.info("No pod key enrolled — onboarding milestones are not sent");
      loggedCredentialSkip = true;
    }
    return;
  }

  let res: Response;
  try {
    res = await fetch(`${cpUrl}/internal/onboarding-milestones`, {
      method: "POST",
      headers: { ...auth.headers, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn({ err }, "CP unreachable — milestones deferred");
    return;
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, "CP did not accept the milestones");
    return;
  }
  await recordOnboardingMilestonesSent(digest);
  logger.info(
    { milestones: payload.milestones.length },
    "Sent onboarding milestones to the CP"
  );
}
