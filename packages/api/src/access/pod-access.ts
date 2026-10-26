/**
 * THE POD-ACCESS FLOOR — "is this principal inside this pod at all?"
 * (plan readiness-plan-access §B, founder 2026-10-26).
 *
 * Signing in proves WHO a person is, not that they belong here. A device token
 * is re-judged on every use (`personHoldsPodAccess`); every other credential
 * (a Kratos session, an API key, an IS delegation) stopped at "authenticated",
 * so a person removed from the pod kept their session and keys. The answer
 * every door needs is the one the device door already uses:
 * `hasActivePodAccess(readPodUserAccess(userId))` (@synap/database).
 *
 *   - `member` — holds access: a live space or project membership, a live
 *     `pod_members` row (a pod invite, 0357), or the pod owner/admin role.
 *   - `guest`  — a guest (`podGuestWhere`): contained by
 *     `access/guest-containment.ts`, never judged here.
 *   - `none`   — signed in, and nothing lets them in.
 *
 * REPORT MODE (wave B1, founder Q-B2): the doors that refuse a guest also
 * call {@link reportNoPodAccess}, which LOGS `pod_access_floor_would_refuse`
 * for a `none` principal and refuses nothing. After one release of reports
 * (wave B3) those same call sites refuse it. In report mode a failed probe is
 * logged too and changes nothing: the report never alters an outcome.
 *
 * Both probes are memoized per incoming request (the `Request` object), so a
 * door that asks twice, or a tRPC batch, costs one read each. Nothing is
 * cached across requests: removal takes effect on the next request.
 */

import { createLogger } from "@synap-core/core";
import { db, hasActivePodAccess, readPodUserAccess } from "@synap/database";
import { AccessContext, type PodAudience } from "./context.js";

const logger = createLogger({ module: "pod-access-floor" });

export type PodAccess = "member" | "guest" | "none";

/** The log event a principal with no pod access raises in report mode. */
export const POD_ACCESS_FLOOR_WOULD_REFUSE = "pod_access_floor_would_refuse";

function memoized<T>(
  cache: WeakMap<object, Map<string, Promise<T>>>,
  requestKey: object | null | undefined,
  userId: string,
  probe: () => Promise<T>
): Promise<T> {
  if (!requestKey) return probe();
  let byUser = cache.get(requestKey);
  if (!byUser) {
    byUser = new Map();
    cache.set(requestKey, byUser);
  }
  let pending = byUser.get(userId);
  if (!pending) {
    pending = probe();
    byUser.set(userId, pending);
    // A failed probe is not memoized: it never reads as an answer.
    pending.catch(() => byUser.delete(userId));
  }
  return pending;
}

const audienceByRequest = new WeakMap<
  object,
  Map<string, Promise<PodAudience>>
>();
const accessByRequest = new WeakMap<object, Map<string, Promise<boolean>>>();

/**
 * `userId`'s audience (`AccessContext.audience()`, the floors' own SQL),
 * memoized per request. `isGuestPrincipal` reads it through here, so the guest
 * refusal and this floor share one probe. A failed probe throws.
 */
export function podAudienceOf(
  userId: string,
  requestKey?: object | null
): Promise<PodAudience> {
  return memoized(audienceByRequest, requestKey, userId, () =>
    AccessContext.operator({ userId }).audience()
  );
}

/** Does `userId` hold access (`hasActivePodAccess`)? Memoized per request; a failed read throws. */
function holdsPodAccess(
  userId: string,
  requestKey?: object | null
): Promise<boolean> {
  return memoized(accessByRequest, requestKey, userId, async () =>
    hasActivePodAccess(await readPodUserAccess(userId, db))
  );
}

/**
 * Who `userId` is to this pod. The guest answer wins: a person the guest
 * containment refuses is a `guest` here too, whatever else they hold. A failed
 * probe throws; it never reads as an answer.
 */
export async function podAccessOf(
  userId: string,
  requestKey?: object | null
): Promise<PodAccess> {
  const [audience, member] = await Promise.all([
    podAudienceOf(userId, requestKey),
    holdsPodAccess(userId, requestKey),
  ]);
  if (audience === "guest") return "guest";
  return member ? "member" : "none";
}

/**
 * REPORT MODE: log `userId` when it holds no pod access and is not a guest
 * (guests are the guest containment's). `door` names the entry point, so the
 * reports say which doors an outsider actually reaches before B3 refuses them.
 * Never throws and never refuses.
 */
export async function reportNoPodAccess(
  userId: string,
  requestKey: object | null | undefined,
  door: string
): Promise<void> {
  try {
    if (await holdsPodAccess(userId, requestKey)) return;
    if ((await podAudienceOf(userId, requestKey)) === "guest") return;
    logger.warn(
      { event: POD_ACCESS_FLOOR_WOULD_REFUSE, door, userId },
      "Pod-access floor (report mode): this principal holds no access to the pod; it will be refused once the floor is enforced"
    );
  } catch (err) {
    logger.warn(
      { event: "pod_access_floor_probe_failed", door, userId, err },
      "Pod-access floor (report mode): the access probe failed; nothing was refused"
    );
  }
}
