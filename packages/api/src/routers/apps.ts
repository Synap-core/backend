/**
 * apps — the pod-admin door to a person's own Applications (App Connect v1).
 *
 * WHY tRPC AND NOT `/api/hub/apps`: `/api/hub` is the AGENT protocol and its
 * auth middleware reads `Authorization: Bearer` / `X-Session-Token` only — it
 * never reads the Kratos COOKIE a browser session holds. Pod Admin is a
 * cookie-authenticated human surface, so its door is tRPC (`apiKeys` is the
 * precedent). Reads/writes are SELF-SCOPED to `ctx.userId`, exactly like
 * `apiKeys.list` / `apiKeys.revoke`: a member sees and can only touch their
 * own apps.
 *
 * The external CLI/agent contract lives at `POST/GET/DELETE /api/hub/apps*`
 * (routers/hub-protocol/rest/apps.ts) — this router is the human UI half and
 * reuses the SAME `AppRepository` (the one write door), so the two can never
 * disagree about what an app is or what revoke does.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, inArray, AppRepository, GrantRepository } from "@synap/database";
import { apiKeys } from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { router, protectedProcedure } from "../trpc.js";

/** The wire shape the UI renders — snake_case, the app + what it may touch. */
function toApp(row: {
  app: {
    id: string;
    publicId: string;
    name: string;
    description: string | null;
    logoUrl: string | null;
    mode: string;
    approvedRequests: unknown;
    createdAt: Date;
    revokedAt: Date | null;
  };
  lastUsedAt: Date | null;
  grants: Array<{
    permissions: string[];
    workspaceIds: string[] | null;
    projectIds: string[] | null;
    entityIds: string[] | null;
    label: string | null;
  }>;
}) {
  return {
    id: row.app.id,
    public_id: row.app.publicId,
    name: row.app.name,
    description: row.app.description,
    logo_url: row.app.logoUrl,
    mode: row.app.mode,
    approved_requests: row.app.approvedRequests ?? null,
    created_at: row.app.createdAt,
    revoked_at: row.app.revokedAt,
    last_used_at: row.lastUsedAt,
    grants: row.grants,
  };
}

export const appsRouter = router({
  /** The caller's own apps, each with the reach it may touch. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await new AppRepository(db).listForOwner(ctx.userId);
    return rows.map(toApp);
  }),

  /**
   * Revoke an app: revoke its keys (which stops its grants resolving), then
   * soft-delete the app. Self-scoped — a caller can only revoke their own.
   */
  revoke: protectedProcedure
    .input(z.object({ publicId: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const repo = new AppRepository(db);
      const found = await repo.getByPublicId(input.publicId);
      if (!found || found.app.ownerUserId !== ctx.userId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
      }
      const keyIds = await repo.keyIdsFor(found.app.publicId);
      if (keyIds.length > 0) {
        // Revoke the keys' grants too (the ONE grant write door) before the
        // keys themselves — a revoked app must not leave an active grant.
        await new GrantRepository(db).revokeForKeys(keyIds, ctx.userId);
        await revokeApiKeys(db, {
          where: inArray(apiKeys.id, keyIds),
          revokedBy: ctx.userId,
          reason: `App revoked: ${found.app.name}`,
        });
      }
      await repo.revoke(found.app.id);
      return { revoked: true, publicId: found.app.publicId };
    }),
});
