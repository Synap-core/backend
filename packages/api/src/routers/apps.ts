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
 * (routers/hub-protocol/rest/apps.ts) — this router is the human UI half. Both
 * call the ONE service `services/app-connect.ts` (request access, issue key,
 * rename, revoke, remove) over the ONE write door `AppRepository`, so the two
 * can never disagree about what an app is or what revoke does.
 */

import { z } from "zod";
import { db, AppRepository } from "@synap/database";
import { router, protectedProcedure } from "../trpc.js";
import {
  issueKey,
  loadOwnedApp,
  removeApp,
  renameApp,
  requestAccess,
  revokeApp,
  serializeApp,
} from "../services/app-connect.js";

const PublicId = z.string().min(1).max(200);

export const appsRouter = router({
  /**
   * The caller's own apps, each with the reach it may touch, any request
   * still waiting (`pending_request`) and its `keys` (what "Key expired" is
   * read from — batched, not one query per app). `includeRevoked` (default
   * false) is the human self-service opt-in: revoked apps render in their
   * "Removed" group instead of vanishing. An app removed for good is never
   * listed. The agent-facing `/api/hub/apps` list never opts in.
   */
  list: protectedProcedure
    .input(z.object({ includeRevoked: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const repo = new AppRepository(db);
      const rows = await repo.listForOwner(ctx.userId, {
        includeRevoked: input?.includeRevoked ?? false,
      });
      const keys = await repo.keysByApp(rows.map((r) => r.app.publicId));
      return rows.map((row) => ({
        ...serializeApp(row),
        keys: keys.get(row.app.publicId) ?? [],
      }));
    }),

  /**
   * Register an app for the caller — the HUMAN half of `POST /api/hub/apps`.
   *
   * IDEMPOTENT BY OWNER+NAME, exactly as `register` is: adding "My intake" twice
   * hands back the SAME app, same `public_id`, rather than a twin. An app's
   * stable id is the `client_id` its grants carry, so a second row would break
   * every key already issued. A previously revoked (or removed) app of that
   * name is revived.
   *
   * Asks the MINIMUM to exist — name, and whatever the person chose to say.
   * Reach is requested on the app's own page (`requestAccess`).
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2000).nullish(),
        logoUrl: z.string().url().max(2000).nullish(),
        // The SYSTEM implements exactly one mode (`specific`).
        mode: z.literal("specific").nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Fields the caller did NOT send stay `undefined` — `register` reads that
      // as "leave it alone", so re-adding an existing name cannot wipe the
      // description it already had.
      const registered = await new AppRepository(db).register({
        ownerUserId: ctx.userId,
        name: input.name,
        description: input.description ?? undefined,
        logoUrl: input.logoUrl ?? undefined,
        mode: input.mode ?? undefined,
      });
      return serializeApp(await loadOwnedApp(registered.publicId, ctx.userId));
    }),

  /** One of the caller's own apps, by public id, with its keys — floored on the owner. */
  get: protectedProcedure
    .input(z.object({ publicId: PublicId }))
    .query(async ({ ctx, input }) => {
      const found = await loadOwnedApp(input.publicId, ctx.userId);
      const keys = await new AppRepository(db).keysFor(found.app.publicId);
      return { ...serializeApp(found), keys };
    }),

  /**
   * Ask for access on the app's behalf — files ONE `app/connect` proposal the
   * owner approves anywhere it shows (phone, Connected page, review link).
   */
  requestAccess: protectedProcedure
    .input(
      z.object({
        publicId: PublicId,
        requests: z
          .array(
            z.object({
              permission: z.string().min(1).max(120),
              workspaceId: z.string().uuid(),
            })
          )
          .min(1)
          .max(64),
      })
    )
    .mutation(({ ctx, input }) =>
      requestAccess({
        publicId: input.publicId,
        ownerUserId: ctx.userId,
        requests: input.requests,
      })
    ),

  /**
   * Issue the app's key after approval ("Issue key" on its page, for apps
   * without the CLI). Rotates away any previous key. The plaintext is in this
   * response ONCE — it is stored nowhere and cannot be shown again.
   */
  issueKey: protectedProcedure
    .input(z.object({ publicId: PublicId }))
    .mutation(({ ctx, input }) =>
      // An agent principal is refused by the service from the request's
      // ambient acting agent (entered at every key-auth door).
      issueKey({
        publicId: input.publicId,
        ownerUserId: ctx.userId,
        via: "ui",
      })
    ),

  /** Rename an app. A name the caller already uses elsewhere is a CONFLICT. */
  rename: protectedProcedure
    .input(
      z.object({ publicId: PublicId, name: z.string().trim().min(1).max(200) })
    )
    .mutation(async ({ ctx, input }) =>
      serializeApp(
        await renameApp({
          publicId: input.publicId,
          ownerUserId: ctx.userId,
          name: input.name,
        })
      )
    ),

  /**
   * Revoke an app: revoke its keys and their grants, then soft-revoke the app.
   * Its history is kept.
   */
  revoke: protectedProcedure
    .input(z.object({ publicId: PublicId }))
    .mutation(async ({ ctx, input }) => {
      const { publicId } = await revokeApp({
        publicId: input.publicId,
        ownerUserId: ctx.userId,
      });
      return { revoked: true, publicId };
    }),

  /**
   * "Remove for good": hide a REVOKED app from every listing. Soft — its row
   * and events stay. A live app answers CONFLICT (revoke it first).
   */
  remove: protectedProcedure
    .input(z.object({ publicId: PublicId }))
    .mutation(async ({ ctx, input }) => {
      const { publicId } = await removeApp({
        publicId: input.publicId,
        ownerUserId: ctx.userId,
      });
      return { removed: true, publicId };
    }),
});
