/**
 * Knowledge Router — the query-understanding brain, exposed over tRPC.
 *
 * A THIN wrapper over the `ask` service (services/knowledge/ask.ts) — the ONE
 * principled query router in the ecosystem (4-substrate classification, profile
 * type inference, hybrid Typesense+pgvector retrieval, glass-box routing). The
 * hub REST `POST /knowledge/search` already exposes this to service callers;
 * this router opens the SAME door to first-party tRPC surfaces (browser palette,
 * relay, Raycast) so no surface ever grows its own natural-language parser.
 *
 * Semantics mirror the hub REST door (rest/knowledge.ts): userId is the
 * authenticated caller; `workspaceId` is the lens — it NARROWS recall, and a
 * null/absent lens means pod-wide (the caller's full floor). The lens is carried,
 * never forced. `parseOnly` returns just the understanding + routing (no
 * retrieval) for a caller that needs to route a query before fetching results.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { getDb, ProfileRepository } from "@synap/database";
import { ask } from "../services/knowledge/index.js";
import {
  toProfileCatalogEntry,
  type ProfileCatalogEntry,
} from "../services/retrieval/index.js";
import {
  validateWorkspaceAccess,
  getUserWorkspaceIds,
} from "../utils/workspace-membership.js";

export const knowledgeRouter = router({
  /**
   * Route a natural-language query across the knowledge substrates and return
   * the matches per substrate PLUS the glass-box understanding (inferred profile
   * types, property/temporal hints) and routing. Pass `parseOnly` to get just
   * the understanding without running retrieval.
   */
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1).max(2000),
        /**
         * Lens — narrows recall to this workspace. Null/absent = pod-wide (the
         * caller's full floor). Silently intersected with the caller's access,
         * so a non-member id degrades to pod-wide rather than leaking.
         */
        workspaceId: z.string().uuid().nullable().optional(),
        limit: z.number().min(1).max(100).optional(),
        /** Return only the understanding + routing (no retrieval). */
        parseOnly: z.boolean().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Validate the requested lens against the caller's access. A member ws
      // narrows; anything else (non-member, absent) degrades to pod-wide (null)
      // — never leaks another workspace's data or vocabulary.
      let lensWs: string | null = null;
      if (input.workspaceId) {
        const allowed = await validateWorkspaceAccess(ctx.userId, [
          input.workspaceId,
        ]);
        lensWs = allowed.includes(input.workspaceId) ? input.workspaceId : null;
      }

      // The semantic engine's CATALOG (type inference) needs a concrete
      // workspace; when no lens is pinned, resolve the caller's first accessible
      // one. Recall still uses the caller's lens (lensWs — null = pod-wide).
      let catalogWs = lensWs;
      if (!catalogWs) {
        const wsIds = await getUserWorkspaceIds(ctx.userId);
        catalogWs = wsIds[0] ?? null;
      }

      let catalog: ProfileCatalogEntry[] = [];
      if (catalogWs) {
        const profileRepo = new ProfileRepository(await getDb());
        const rows = await profileRepo.getAccessibleProfiles(
          ctx.userId,
          catalogWs
        );
        catalog = rows.flatMap((p) => {
          const entry = toProfileCatalogEntry(p);
          return entry ? [entry] : [];
        });
      }

      return ask({
        query: input.query,
        userId: ctx.userId,
        workspaceId: lensWs,
        limit: input.limit,
        catalog,
        parseOnly: input.parseOnly || undefined,
      });
    }),
});
