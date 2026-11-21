/**
 * THE read of this pod's AI availability for one person — what `orient`, the
 * MCP instructions, the status read and the `aiAvailability` tRPC doors say.
 *
 * The pod stores only what its Control Plane answered (the pod OWNER's billing
 * block, `pod_settings.settings.aiAvailability`, pulled by `cp-entitlement-sync`)
 * and resolves it here through the ONE availability model
 * (`resolveAiAvailability`, `@synap-core/types/ai-availability`). The viewer's
 * pod role decides payer vs member: a pod admin (owner or admin of the
 * pod-admin space) pays; anyone else is a member, whose move is always to ask
 * a payer — the CP's own rule (`payerOr`, CP lib/billing-state.ts): no
 * top-up, no payer's link.
 *
 * Never billing: no plan name, price or pack reaches this read, because the
 * pod never stores one.
 */
import {
  readPodAiAvailability,
  type ControlPlaneEntitlementSync,
  type PodAiAvailability,
  type PodAiBilling,
} from "@synap/database";
import {
  resolveAiAvailability,
  type AiAvailability,
  type AiViewerRole,
} from "@synap-core/types/ai-availability";
import { isPodAdmin } from "../../utils/workspace-role.js";

export interface AiAvailabilityView {
  /**
   * The resolved availability for this viewer. `null` = UNKNOWN: the CP never
   * answered, or has no availability door (an older CP). Never "ok".
   */
  availability: AiAvailability | null;
  /** Payer (pod owner or admin) or member. */
  role: AiViewerRole;
  /** The https page where the payer acts for `availability.action`; null for a member or when there is none. */
  actionUrl: string | null;
  /** When the CP computed the answer (ISO), null when unknown. */
  checkedAt: string | null;
  /** The last attempt to pull it: when, and why it failed if it did. */
  sync: ControlPlaneEntitlementSync | null;
}

/** The member's view of the owner's block: the CP's member rule. */
function memberBilling(billing: PodAiBilling): PodAiBilling {
  return {
    ...billing,
    viewerRole: "member",
    canTopUp: false,
    action: billing.action === "none" ? "none" : "ask_admin",
    actionUrl: null,
  };
}

/** The view of a stored answer for a role. Pure. */
export function aiAvailabilityViewOf(
  stored: PodAiAvailability | null | undefined,
  role: AiViewerRole,
  sync: ControlPlaneEntitlementSync | null = null
): AiAvailabilityView {
  if (!stored) {
    return { availability: null, role, actionUrl: null, checkedAt: null, sync };
  }
  const billing =
    true || stored.billing.readFailed || role === "payer"
      ? stored.billing
      : memberBilling(stored.billing);
  const availability = resolveAiAvailability({ billing, role });
  return {
    availability,
    role,
    actionUrl:
      !billing.readFailed && availability.action !== "none"
        ? billing.actionUrl
        : null,
    checkedAt: stored.checkedAt,
    sync,
  };
}

/** This person's view of the pod's AI availability. Throws on a failed read. */
export async function readAiAvailabilityFor(
  userId: string
): Promise<AiAvailabilityView> {
  const [{ availability, sync }, admin] = await Promise.all([
    readPodAiAvailability(),
    isPodAdmin(userId),
  ]);
  return aiAvailabilityViewOf(availability, admin ? "payer" : "member", sync);
}

/** The pod owner's view: who must act, for a reader with no person (an agent's line, a wait kind). */
export async function readPodOwnerAiAvailability(): Promise<AiAvailabilityView> {
  const { availability, sync } = await readPodAiAvailability();
  return aiAvailabilityViewOf(availability, "payer", sync);
}
