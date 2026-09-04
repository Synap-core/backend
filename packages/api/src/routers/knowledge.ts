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
import { synthesizeAnswer } from "../services/knowledge/synthesize.js";
import {
  toProfileCatalogEntry,
  type ProfileCatalogEntry,
} from "../services/retrieval/index.js";
import {
  validateWorkspaceAccess,
  getUserWorkspaceIds,
} from "../utils/workspace-membership.js";

/**
 * Resolve the caller's LENS and the type-inference CATALOG.
 *
 * Shared by `search` and `answer` on purpose: `answer` is the same retrieval
 * with one synthesis step bolted on, so if it resolved the lens itself the two
 * doors could disagree about what a caller is allowed to see — and a divergence
 * in an ACCESS decision is the expensive kind. One resolution, two doors.
 *
 * A requested workspace the caller is not a member of degrades to pod-wide
 * (null) rather than throwing or leaking: the lens is carried, never forced.
 */
async function resolveLensAndCatalog(
  userId: string,
  requestedWorkspaceId: string | null | undefined
): Promise<{ lensWs: string | null; catalog: ProfileCatalogEntry[] }> {
  let lensWs: string | null = null;
  if (requestedWorkspaceId) {
    const allowed = await validateWorkspaceAccess(userId, [
      requestedWorkspaceId,
    ]);
    lensWs = allowed.includes(requestedWorkspaceId)
      ? requestedWorkspaceId
      : null;
  }

  // The semantic engine's CATALOG (type inference) needs a concrete workspace;
  // when no lens is pinned, resolve the caller's first accessible one. Recall
  // still uses the caller's lens (lensWs — null = pod-wide).
  let catalogWs = lensWs;
  if (!catalogWs) {
    const wsIds = await getUserWorkspaceIds(userId);
    catalogWs = wsIds[0] ?? null;
  }

  let catalog: ProfileCatalogEntry[] = [];
  if (catalogWs) {
    const profileRepo = new ProfileRepository(await getDb());
    const rows = await profileRepo.getAccessibleProfiles(userId, catalogWs);
    catalog = rows.flatMap((p) => {
      const entry = toProfileCatalogEntry(p);
      return entry ? [entry] : [];
    });
  }

  return { lensWs, catalog };
}

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
      const { lensWs, catalog } = await resolveLensAndCatalog(
        ctx.userId,
        input.workspaceId
      );

      return ask({
        query: input.query,
        userId: ctx.userId,
        workspaceId: lensWs,
        limit: input.limit,
        catalog,
        parseOnly: input.parseOnly || undefined,
      });
    }),

  /**
   * Tier-2 read: retrieve, then SYNTHESIZE one direct answer over the matches.
   *
   * `search` returns raw matches; this returns a sentence plus the sources it
   * drew from. The hub REST `POST /knowledge/answer` has exposed exactly this
   * to service callers for a while — it is the Intelligence-Service door, so a
   * first-party app could not use it, and Relay's "ask" had no way to be
   * anything but a search box. This opens the SAME service pair (`ask` then
   * `synthesizeAnswer`) to tRPC surfaces. No second retrieval path, no second
   * prompt.
   *
   * `answer` is NULLABLE by contract, and that is load-bearing: when synthesis
   * is unavailable the sources are still returned, so the caller degrades to
   * showing matches rather than showing nothing. A UI must render the sources
   * whether or not the sentence arrived, and must never present an absent
   * answer as "nothing found" — those are different facts.
   */
  answer: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1).max(2000),
        /** Lens — narrows recall. Null/absent = pod-wide (caller's floor). */
        workspaceId: z.string().uuid().nullable().optional(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { lensWs, catalog } = await resolveLensAndCatalog(
        ctx.userId,
        input.workspaceId
      );

      const result = await ask({
        query: input.query,
        userId: ctx.userId,
        workspaceId: lensWs,
        limit: input.limit,
        catalog,
      });

      // Pending count is forwarded so a query that matches the caller's own
      // un-approved captures cannot come back "no information found" while a
      // non-empty pending block sits right beside it.
      const synthesis = await synthesizeAnswer(
        result.answers,
        input.query,
        result.routedTo,
        lensWs,
        result.pending?.matches?.length ?? 0
      );

      return {
        answer: synthesis.answer,
        sources: synthesis.sources,
        routedTo: synthesis.routedTo,
        /** True when retrieval succeeded but synthesis did not. */
        synthesisFailed: Boolean(synthesis.error),
        /**
         * Retrieval-health tags forwarded from `ask()` — substrates that
         * errored, plus `semantic:vector-down` when the embedding provider was
         * down and the semantic leg ran keyword-only (measurably thinner
         * recall). Without this a caller cannot tell a thin answer from a
         * healthy one, which is exactly the distinction the REST door already
         * publishes. Same field name, same meaning.
         */
        degraded: result.degraded,
      };
    }),
});
