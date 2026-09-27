/**
 * Shares Router — the owner's sharing doors.
 *
 * Every rule lives in `services/sharing/share-service.ts` (the same core the Hub
 * REST `/shares` routes, the `relations.exposeToAnchor` alias and the
 * `share/create` approval executor call). This router only maps the tRPC
 * context to a {@link ShareActor} and validates input.
 *
 * Procedures:
 *   - share        expose a record to a project's guests, or share it by LINK.
 *                  Human owner: direct (a new link's token is returned ONCE).
 *                  Agent: always a proposal (ADMIN floor, no rule widens it).
 *   - unshare      stop sharing a record with a project (exposure removed, its
 *                  live links revoked). Direct for everyone.
 *   - revokeLink   revoke one link, permanently. Direct for everyone. The
 *                  guests who joined THROUGH IT are removed too unless
 *                  `removeGuests: false` (default true); guests added any
 *                  other way are never touched.
 *   - removeGuest  remove one GUEST from a project, directly and for good
 *                  (anchor owner / workspace owner or admin).
 *   - listShares   exposures + links of a record, or of an anchor project. Capped.
 *   - rotateLink   mint a link's secret (human only), returned ONCE.
 *   - redeemLink   a signed-in person joins the link's project as a GUEST.
 *   - getPolicy / setPolicy   the workspace's exposure policy (owner only;
 *                  setPolicy is human only — agents have no policy door).
 *                  Tightening it never retracts what is already shared:
 *                  `policyChangeEffect` says so for the surface to show.
 *   - getPublicDoors / setPublicDoors   do this workspace's public pages
 *                  and forms answer at all (owner only; set is human only).
 *                  OFF by default on a pod whose visitors share one client
 *                  IP (`services/sharing/public-doors-switch.ts`).
 *   - publish      put a record on the public web (`publish-service.ts`):
 *                  snapshot of the policy's allowlisted fields + pinned
 *                  checkpoint, addressed by a token shown ONCE. Human owner:
 *                  direct. Agent: always a proposal (same ADMIN-floored door).
 *   - unpublish    take it off again (back to draft, same URL on republish).
 *                  Direct for everyone; never un-revokes.
 *   - revokePublication  kill a record's public url for good: revoked
 *                  + frozen by the 0276 trigger; publishing again mints a NEW
 *                  url. Direct for everyone, agents included.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  getExposurePolicy,
  getPublicDoors,
  listShares,
  redeemLink,
  removeGuest,
  revokeLink,
  rotateLink,
  setExposurePolicy,
  setPublicDoors,
  shareResource,
  unshareResource,
  SHARE_AUDIENCES,
  type ShareActor,
} from "../services/sharing/share-service.js";
import {
  ExposurePolicyInputSchema,
  POLICY_CHANGE_EFFECT,
  SHARE_KINDS,
} from "../services/sharing/exposure-policy.js";
import { registerShareExecutors } from "../services/sharing/share-executors.js";
import {
  publishResource,
  revokePublication,
  unpublishResource,
} from "../services/sharing/publish-service.js";

// The approval half of `share/create` — registered with this router's module so
// the approve path (same process, `root.ts` mounts this router) always has it.
registerShareExecutors();

const Uuid = z.string().uuid();
const Kind = z.enum(SHARE_KINDS);

/** The share door's actor, from the authenticated tRPC context. */
export function shareActorFromCtx(ctx: {
  userId: string;
  agentUserId?: string | null;
  source?: string | null;
  keyType?: string | null;
}): ShareActor {
  return {
    userId: ctx.userId,
    agentUserId: ctx.agentUserId ?? null,
    source: ctx.source ?? null,
    keyType: ctx.keyType ?? null,
  };
}

export const sharesRouter = router({
  share: protectedProcedure
    .input(
      z.object({
        resourceType: Kind,
        resourceId: Uuid,
        anchorProjectId: Uuid.optional(),
        audience: z.enum(SHARE_AUDIENCES),
        expiresAt: z.coerce.date().optional(),
        reasoning: z.string().max(2000).optional(),
      })
    )
    .mutation(({ input, ctx }) =>
      shareResource(
        { ...shareActorFromCtx(ctx), reasoning: input.reasoning },
        {
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          anchorProjectId: input.anchorProjectId,
          audience: input.audience,
          expiresAt: input.expiresAt ?? null,
        }
      )
    ),

  unshare: protectedProcedure
    .input(
      z.object({
        resourceType: Kind,
        resourceId: Uuid,
        anchorProjectId: Uuid.optional(),
      })
    )
    .mutation(({ input, ctx }) =>
      unshareResource(shareActorFromCtx(ctx), input)
    ),

  revokeLink: protectedProcedure
    .input(z.object({ shareId: Uuid, removeGuests: z.boolean().optional() }))
    .mutation(({ input, ctx }) =>
      revokeLink(shareActorFromCtx(ctx), input.shareId, {
        // The default lives in the core (`revokeLink`): undefined = remove.
        removeGuests: input.removeGuests,
      })
    ),

  removeGuest: protectedProcedure
    .input(z.object({ projectId: Uuid, userId: z.string().min(1).max(200) }))
    .mutation(({ input, ctx }) => removeGuest(shareActorFromCtx(ctx), input)),

  listShares: protectedProcedure
    .input(
      z.union([
        z.object({ resourceType: Kind, resourceId: Uuid }),
        z.object({ anchorProjectId: Uuid }),
      ])
    )
    .query(({ input, ctx }) => listShares(shareActorFromCtx(ctx), input)),

  rotateLink: protectedProcedure
    .input(z.object({ shareId: Uuid }))
    .mutation(({ input, ctx }) =>
      rotateLink(shareActorFromCtx(ctx), input.shareId)
    ),

  // `token` is the input key the tRPC audit middleware redacts.
  redeemLink: protectedProcedure
    .input(z.object({ token: z.string().min(1).max(256) }))
    .mutation(({ input, ctx }) =>
      redeemLink(shareActorFromCtx(ctx), input.token)
    ),

  publish: protectedProcedure
    .input(
      z.object({
        resourceType: Kind,
        resourceId: Uuid,
        reasoning: z.string().max(2000).optional(),
      })
    )
    .mutation(({ input, ctx }) =>
      publishResource(
        { ...shareActorFromCtx(ctx), reasoning: input.reasoning },
        { resourceType: input.resourceType, resourceId: input.resourceId }
      )
    ),

  unpublish: protectedProcedure
    .input(z.object({ resourceType: Kind, resourceId: Uuid }))
    .mutation(({ input, ctx }) =>
      unpublishResource(shareActorFromCtx(ctx), input)
    ),

  revokePublication: protectedProcedure
    .input(z.object({ resourceType: Kind, resourceId: Uuid }))
    .mutation(({ input, ctx }) =>
      revokePublication(shareActorFromCtx(ctx), input)
    ),

  getPolicy: protectedProcedure
    .input(z.object({ workspaceId: Uuid }))
    .query(({ input, ctx }) =>
      getExposurePolicy(shareActorFromCtx(ctx), input.workspaceId)
    ),

  setPolicy: protectedProcedure
    .input(
      z.object({
        workspaceId: Uuid,
        // The strict, COMPLETE policy schema (no `update` / `delete`; every
        // kind × audience × action + public `fields` required — a partial
        // payload is refused, never erased). The service re-validates it.
        // `null` resets to the code default.
        policy: ExposurePolicyInputSchema.nullable(),
      })
    )
    .mutation(({ input, ctx }) =>
      setExposurePolicy(shareActorFromCtx(ctx), input.workspaceId, input.policy)
    ),

  // Kept OFF `setPolicy`'s response on purpose: that response is the policy
  // itself, and clients store it as the `getPolicy` answer they send back.
  policyChangeEffect: protectedProcedure.query(() => POLICY_CHANGE_EFFECT),

  getPublicDoors: protectedProcedure
    .input(z.object({ workspaceId: Uuid }))
    .query(({ input, ctx }) =>
      getPublicDoors(shareActorFromCtx(ctx), input.workspaceId)
    ),

  setPublicDoors: protectedProcedure
    .input(
      z.object({
        workspaceId: Uuid,
        // true = on, false = off, null = back to the pod default.
        enabled: z.boolean().nullable(),
      })
    )
    .mutation(({ input, ctx }) =>
      setPublicDoors(shareActorFromCtx(ctx), input.workspaceId, input.enabled)
    ),
});
