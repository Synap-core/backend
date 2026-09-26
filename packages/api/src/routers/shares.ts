/**
 * Shares Router — the owner's sharing doors (Sites W2 S3).
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
 *   - revokeLink   revoke one link, permanently. Direct for everyone. Guests who
 *                  already joined through it stay members.
 *   - listShares   exposures + links of a record, or of an anchor project. Capped.
 *   - rotateLink   mint a link's secret (human only), returned ONCE.
 *   - redeemLink   a signed-in person joins the link's project as a GUEST.
 *   - getPolicy / setPolicy   the workspace's exposure policy (owner only;
 *                  setPolicy is human only — agents have no policy door).
 *   - publish      put a record on the public web (W5a, `publish-service.ts`):
 *                  snapshot of the policy's allowlisted fields + pinned
 *                  checkpoint, addressed by a token shown ONCE. Human owner:
 *                  direct. Agent: always a proposal (same ADMIN-floored door).
 *   - unpublish    take it off again (back to draft, same URL on republish).
 *                  Direct for everyone; never un-revokes.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  getExposurePolicy,
  listShares,
  redeemLink,
  revokeLink,
  rotateLink,
  setExposurePolicy,
  shareResource,
  unshareResource,
  SHARE_AUDIENCES,
  type ShareActor,
} from "../services/sharing/share-service.js";
import {
  ExposurePolicyInputSchema,
  SHARE_KINDS,
} from "../services/sharing/exposure-policy.js";
import { registerShareExecutors } from "../services/sharing/share-executors.js";
import {
  publishResource,
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
    .input(z.object({ shareId: Uuid }))
    .mutation(({ input, ctx }) =>
      revokeLink(shareActorFromCtx(ctx), input.shareId)
    ),

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

  getPolicy: protectedProcedure
    .input(z.object({ workspaceId: Uuid }))
    .query(({ input, ctx }) =>
      getExposurePolicy(shareActorFromCtx(ctx), input.workspaceId)
    ),

  setPolicy: protectedProcedure
    .input(
      z.object({
        workspaceId: Uuid,
        // The strict policy schema (no `update` / `delete` anywhere); the
        // service re-validates it. `null` resets to the code default.
        policy: ExposurePolicyInputSchema.nullable(),
      })
    )
    .mutation(({ input, ctx }) =>
      setExposurePolicy(shareActorFromCtx(ctx), input.workspaceId, input.policy)
    ),
});
