/**
 * THE PUBLIC DOORS SWITCH — may a workspace's public pages and forms
 * (`/api/hub/public/*`) answer at all?
 *
 * WHY. The public doors are rate-limited per client IP. A pod reached through a
 * shared-IP ingress (a Cloudflare tunnel: every request arrives from the
 * `cloudflared` peer) has ONE bucket for the whole internet, so a single abuser
 * 429s every page and form on the pod for every real visitor, and a flood of
 * submissions cannot be told apart by source. Until such a pod trusts a real
 * client IP (Caddy `trusted_proxies` + `CF-Connecting-IP`), its public doors are
 * OFF unless the workspace owner turns them on knowingly.
 *
 * THE SIGNAL. `SYNAP_SHARED_CLIENT_IP` in the pod env (`true` / `1` / `yes` /
 * `on`). The deploy compose derives it from the presence of a tunnel token, and
 * an operator who fixed the client IP sets it to `false`. Unset = a pod with
 * distinct client IPs, and the doors keep answering as before.
 *
 * THE OWNER'S CHOICE. `publicDoorsEnabled` (boolean) inside the stored exposure
 * policy, written only by `shares.setPublicDoors` (owner, signed-in human). It
 * lives inside that server-owned settings key, so no generic settings writer
 * can plant or erase it, and `shares.setPolicy` carries it over (that door
 * replaces the grid, not this switch). This file only READS it, through
 * `storedExposurePolicyRecord`, so the key keeps its one set of owners.
 * Absent = the pod default:
 *   - no shared-IP signal → ON (the doors behave exactly as before);
 *   - shared-IP signal    → OFF until the owner turns it on.
 * An explicit `false` turns a workspace's doors off on any pod.
 *
 * THE REFUSAL. A live token behind a closed switch answers 403 with
 * {@link PUBLIC_DOORS_DISABLED_BODY} — never the 404 of a miss, never a 429.
 * It is decided only AFTER the token resolved to a live share or form, so an
 * unknown, revoked or expired token still gets the uniform 404 / 202: the
 * refusal tells a caller nothing a 200 would not have told them.
 */

import { db, eq } from "@synap/database";
import { workspaces } from "@synap/database/schema";
import { storedExposurePolicyRecord } from "./exposure-policy.js";

/** The pod env flag that says client IPs are NOT distinct. */
export const SHARED_CLIENT_IP_ENV = "SYNAP_SHARED_CLIENT_IP";

/** Where the owner's choice lives, inside the stored exposure policy. */
export const PUBLIC_DOORS_KEY = "publicDoorsEnabled" as const;

/** The one refusal body. `code` is the machine-readable part a client keys on. */
export const PUBLIC_DOORS_DISABLED_BODY = Object.freeze({
  error:
    "The owner has not turned on public pages and forms for this workspace.",
  code: "public_doors_disabled" as const,
});
export const PUBLIC_DOORS_DISABLED_STATUS = 403 as const;

/** True when the pod says every visitor shares one client IP. */
export function sharedClientIpFromEnv(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env[SHARED_CLIENT_IP_ENV];
  return (
    typeof raw === "string" &&
    ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
  );
}

/** The owner's stored choice, or null when they never made one. */
export function storedPublicDoorsChoice(settings: unknown): boolean | null {
  const value = storedExposurePolicyRecord(settings)?.[PUBLIC_DOORS_KEY];
  return typeof value === "boolean" ? value : null;
}

export interface PublicDoorsState {
  /** Do this workspace's public pages and forms answer right now? */
  enabled: boolean;
  /** The owner's explicit choice; null = the pod default applies. */
  ownerChoice: boolean | null;
  /** The pod cannot tell visitors apart (the reason the default is off). */
  sharedClientIp: boolean;
}

/** Pure: the switch from a settings blob and the pod signal. */
export function resolvePublicDoors(
  settings: unknown,
  sharedClientIp: boolean
): PublicDoorsState {
  const ownerChoice = storedPublicDoorsChoice(settings);
  return {
    enabled: ownerChoice ?? !sharedClientIp,
    ownerChoice,
    sharedClientIp,
  };
}

/**
 * The switch for one workspace, read from the database. With no workspace row
 * there is no owner choice to read, so the pod default applies. Throws on a
 * failed read — the doors turn that into a 5xx, never a calm refusal.
 */
export async function publicDoorsOpenFor(
  workspaceId: string | null
): Promise<boolean> {
  const shared = sharedClientIpFromEnv();
  if (!workspaceId) return !shared;
  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return resolvePublicDoors(ws?.settings ?? null, shared).enabled;
}
