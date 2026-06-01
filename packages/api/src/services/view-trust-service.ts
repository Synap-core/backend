/**
 * View Trust Resolution
 *
 * Server-side authority for whether a framed-view-originated write may execute
 * directly or must route to a proposal. Implements the "trust is asserted by
 * the host, re-verified by the server" rule from the View Trust + Capability
 * Model (synap-team-docs/.../view-trust-capability-model.mdx).
 *
 * SECURITY CONTRACT — read before changing:
 *   - The sandboxed iframe posts ONLY `{ operation, payload }`. It can NOT
 *     supply a viewId, typeKey, or trust flag.
 *   - The React HOST (BrowserViewFrameCell, outside the sandbox) stamps the
 *     view's identity (`viewId` / `typeKey`) from its own registration props.
 *     That identity is a *hint about which definition is asking* — it is never
 *     a trust assertion.
 *   - This function RE-RESOLVES trust from the database (views.userId /
 *     widget_definitions.trust_level). The returned `trusted` boolean is the
 *     only thing checkPermissionOrPropose acts on.
 *   - Default is fail-safe: anything unknown, unresolvable, or not positively
 *     proven `trusted` returns `{ trusted: false }` → the gate proposes.
 *
 * A request body MUST NOT be allowed to set trust. Callers pass the host-stamped
 * identity through a dedicated, separately-named input field and resolve it
 * here; they never forward a client-supplied `trusted` value to the gate.
 */

import { db, eq, and, or, isNull } from "@synap/database";
import { views, widgetDefinitions } from "@synap/database/schema";
import type { IssuerTrust } from "../utils/permission-check.js";

/**
 * Host-stamped identity of the framed view requesting a mutation.
 *
 * Both fields are OPTIONAL and may be absent (e.g. an ad-hoc preview frame with
 * no persisted definition). Absent identity → untrusted → propose.
 */
export interface ViewIdentity {
  /** `views.id` — present when the frame renders a persisted, user-owned view. */
  viewId?: string | null;
  /** `widget_definitions.type_key` — the cell/widget definition key. */
  typeKey?: string | null;
}

/**
 * Resolve the trust of a framed-view-originated mutation, SERVER-SIDE.
 *
 * Returns an `IssuerTrust` with `kind: "view"`. `trusted` is true ONLY when
 * positively proven:
 *   1. The view is persisted and authored by the acting user
 *      (`views.userId === userId`), OR
 *   2. The backing widget definition is marked `trust_level = "trusted"`
 *      (set exclusively by a human-approved install/publish path).
 *
 * `installed` / `generated` definitions, unknown identities, and any resolution
 * failure all yield `{ trusted: false }` → the permission gate proposes.
 *
 * @param identity   Host-stamped view identity (NEVER from the iframe / request body).
 * @param userId     The acting operator's user id (from the auth boundary).
 * @param workspaceId Active workspace lens, or null for pod-wide.
 */
export async function resolveViewTrust(
  identity: ViewIdentity,
  userId: string,
  workspaceId: string | null
): Promise<IssuerTrust> {
  const untrusted: IssuerTrust = { kind: "view", trusted: false };

  try {
    // 1. User-authored view → trusted. A view the acting user created is, by
    //    definition, acting on their behalf within what they declared.
    if (identity.viewId) {
      const [view] = await db
        .select({ userId: views.userId })
        .from(views)
        .where(eq(views.id, identity.viewId))
        .limit(1);

      if (view && view.userId === userId) {
        return { kind: "view", trusted: true };
      }
      // A viewId that resolves to someone else's view (or no row) is NOT a
      // grounds for trust — fall through to the definition check.
    }

    // 2. Backing widget definition marked trust_level = "trusted".
    //    type_key is unique within a scope (workspace row, else system NULL).
    //    Prefer the workspace-scoped row, then the system-wide built-in.
    if (identity.typeKey) {
      const candidates = await db
        .select({
          workspaceId: widgetDefinitions.workspaceId,
          trustLevel: widgetDefinitions.trustLevel,
        })
        .from(widgetDefinitions)
        .where(
          workspaceId
            ? and(
                eq(widgetDefinitions.typeKey, identity.typeKey),
                // workspace-scoped to this workspace OR system-wide built-in
                or(
                  eq(widgetDefinitions.workspaceId, workspaceId),
                  isNull(widgetDefinitions.workspaceId)
                )
              )
            : and(
                eq(widgetDefinitions.typeKey, identity.typeKey),
                isNull(widgetDefinitions.workspaceId)
              )
        );

      if (candidates.length > 0) {
        // Resolve the most specific row: workspace-scoped beats system-wide.
        const scoped = candidates.find((c) => c.workspaceId === workspaceId);
        const chosen = scoped ?? candidates[0];
        if (chosen.trustLevel === "trusted") {
          return { kind: "view", trusted: true };
        }
      }
    }
  } catch {
    // Any resolution failure is fail-safe: treat as untrusted → propose.
    return untrusted;
  }

  // No positive proof of trust → propose.
  return untrusted;
}
