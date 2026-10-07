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
  /**
   * The caller's own apps, each with the reach it may touch. `includeRevoked`
   * (default false) is the human self-service opt-in: pod-admin's "Apps & access"
   * page renders revoked apps in its "Revoked apps" section instead of letting
   * them vanish. The agent-facing `/api/hub/apps` list never opts in.
   */
  list: protectedProcedure
    .input(z.object({ includeRevoked: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await new AppRepository(db).listForOwner(ctx.userId, {
        includeRevoked: input?.includeRevoked ?? false,
      });
      return rows.map(toApp);
    }),

  /**
   * Register an app for the caller — the HUMAN half of `POST /api/hub/apps`.
   *
   * That door authenticates with a Bearer / `X-Session-Token` key and never
   * reads the Kratos cookie a browser session holds (see the module docblock),
   * so a person adding an app from the UI has no door at all today. This is it,
   * and it reuses the SAME `AppRepository.register`, so the CLI and the UI
   * cannot mint two different kinds of app.
   *
   * IDEMPOTENT BY OWNER+NAME, exactly as `register` is: adding "My intake" twice
   * hands back the SAME app, same `public_id`, rather than a twin. An app's
   * stable id is the `client_id` its grants carry, so a second row would break
   * every key already issued. A previously revoked app of that name is revived.
   *
   * Asks the MINIMUM to exist — name, and whatever the person chose to say.
   * Reach (which permissions, which spaces) is NOT asked here: it is requested
   * on the app's own page, where the person can see what it would mean
   * (`OBJECT-CREATION-UX-PRINCIPLE`: land on the detail page, configure there).
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2000).nullish(),
        logoUrl: z.string().url().max(2000).nullish(),
        // The column is text, but the SYSTEM implements exactly one mode
        // (`AppMode = "specific"` in the CLI; the schema comment puts global and
        // runtime OAuth out of scope for v1). A bounded free string let a caller
        // store any token the detail read never renders — bound it to what runs.
        mode: z.literal("specific").nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const repo = new AppRepository(db);
      // Fields the caller did NOT send stay `undefined` — `register` reads that
      // as "leave it alone", so re-adding an existing name cannot wipe the
      // description it already had. Coercing to `null` here would have made the
      // no-op-looking re-add destructive.
      const registered = await repo.register({
        ownerUserId: ctx.userId,
        name: input.name,
        description: input.description ?? undefined,
        logoUrl: input.logoUrl ?? undefined,
        mode: input.mode ?? undefined,
      });
      // Re-read through the ONE projection so a create returns exactly what
      // `get` returns — a caller never sees two shapes for one app.
      const found = await repo.getByPublicId(registered.publicId);
      if (!found) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "App registered but could not be read back.",
        });
      }
      return toApp(found);
    }),

  /**
   * One of the caller's own apps, by public id — floored on the owner.
   *
   * This is the DETAIL read, and it is the only one that carries `keys`: `list`
   * is a browsable index of many apps, where a per-app key query would be an
   * N+1 for data the list does not show. The two therefore differ by exactly
   * one field, which is that field's whole reason for existing.
   */
  get: protectedProcedure
    .input(z.object({ publicId: z.string().min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const repo = new AppRepository(db);
      const found = await repo.getByPublicId(input.publicId);
      if (!found || found.app.ownerUserId !== ctx.userId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
      }
      const keys = await repo.keysFor(found.app.publicId);
      return { ...toApp(found), keys };
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
