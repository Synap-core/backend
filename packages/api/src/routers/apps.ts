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
 *
 * The `admin*` procedures are the pod admin's door to EVERY member's apps
 * (the console's Apps page): read any, and END any (revoke, remove for good)
 * through the same service with the owner floor lifted. Asking for access,
 * issuing a key and renaming stay the owner's.
 *
 * Pod apps (spec 17 PB4): `list` / `get` carry `pod_app` (domain, tier,
 * approval per space, write mode); `narrow` and `setWriteMode` are the
 * owner's; `adminPodApps` / `adminRevokeClient` / `adminPolicy` /
 * `adminSetPolicy` the pod admin's, never an agent's.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, AppRepository } from "@synap/database";
import { router, podAdminProcedure, protectedProcedure } from "../trpc.js";
import {
  adminPodApps,
  adminRevokePodAppClient,
  issueKey,
  loadOwnedApp,
  narrowApp,
  podAppViews,
  registerApp,
  removeApp,
  renameApp,
  requestAccess,
  revokeApp,
  serializeApp,
  serializeAppsForAdmin,
  setAppRedirectUris,
  setAppSignInPolicy,
  setAppWriteMode,
} from "../services/app-connect.js";
import {
  countLiveUnverifiedConnections,
  readPodAppPolicy,
  setPodAppPolicy,
} from "../services/pod-app-policy.js";
import { isAgentCaller } from "../services/library/agent-door.js";
import type { Context } from "../types/context.js";

const PublicId = z.string().min(1).max(200);

/** One (permission, space) pair of an approval, as the doors send it. */
const ApprovedPair = z.object({
  permission: z.string().min(1).max(120),
  workspaceId: z.string().uuid(),
});

/**
 * The pod admin's policy doors are a PERSON's act: an agent's credential
 * acting for an admin is refused, as every app-lifecycle write refuses it.
 */
function refuseAgentCredential(ctx: Context, act: string): void {
  if (isAgentCaller({ agentUserId: ctx.agentUserId, keyType: ctx.keyType })) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `An agent credential cannot ${act} — sign in as a pod admin.`,
    });
  }
}

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
      const pod = await podAppViews(rows, keys);
      return rows.map((row) => ({
        ...serializeApp(row),
        keys: keys.get(row.app.publicId) ?? [],
        /** A pod app's domain, tier, approval and write mode; null otherwise. */
        pod_app: pod.get(row.app.publicId) ?? null,
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
      // description it already had. An agent principal / scoped key is
      // refused by the service (`assertOwnerCredential`), as every lifecycle
      // write is.
      return serializeApp(
        await registerApp({
          ownerUserId: ctx.userId,
          name: input.name,
          description: input.description ?? undefined,
          logoUrl: input.logoUrl ?? undefined,
          mode: input.mode ?? undefined,
        })
      );
    }),

  /** One of the caller's own apps, by public id, with its keys — floored on the owner. */
  get: protectedProcedure
    .input(z.object({ publicId: PublicId }))
    .query(async ({ ctx, input }) => {
      const found = await loadOwnedApp(input.publicId, ctx.userId);
      const keys = await new AppRepository(db).keysFor(found.app.publicId);
      const pod = await podAppViews(
        [found],
        new Map([[found.app.publicId, keys]])
      );
      return {
        ...serializeApp(found),
        keys,
        pod_app: pod.get(found.app.publicId) ?? null,
      };
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
   * Narrow an app without a new consent (PB4): `approved` is what it KEEPS —
   * pairs of its current approval, at least one. Applies at once (it only
   * reduces access); a pod app's live token stops now and its next refresh
   * carries the narrower reach.
   */
  narrow: protectedProcedure
    .input(
      z.object({
        publicId: PublicId,
        approved: z.array(ApprovedPair).min(1).max(64),
      })
    )
    .mutation(async ({ ctx, input }) =>
      serializeApp(
        await narrowApp({
          publicId: input.publicId,
          ownerUserId: ctx.userId,
          approved: input.approved,
          actorAgentUserId: ctx.agentUserId,
          actorKeyType: ctx.keyType,
        })
      )
    ),

  /**
   * "Sign in with Synap": replace where a person's sign-in code for this app
   * may be delivered (exact match; `[]` = the app signs no one in). Owner only.
   */
  setRedirectUris: protectedProcedure
    .input(
      z.object({
        publicId: PublicId,
        redirectUris: z.array(z.string().min(1).max(2048)).max(8),
      })
    )
    .mutation(async ({ ctx, input }) =>
      serializeApp(
        await setAppRedirectUris({
          publicId: input.publicId,
          ownerUserId: ctx.userId,
          redirectUris: input.redirectUris,
          // Same credential facts the Hub door passes (PR #29 L3).
          actorAgentUserId: ctx.agentUserId,
          actorKeyType: ctx.keyType,
        })
      )
    ),

  /**
   * The per-app "apply automatically" switch (F6): ON = the app's changes
   * follow the pod's default, OFF = every change asks first (where every
   * connection starts). The owner's own act; an agent is refused.
   */
  setWriteMode: protectedProcedure
    .input(z.object({ publicId: PublicId, applyAutomatically: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setAppWriteMode({
        publicId: input.publicId,
        ownerUserId: ctx.userId,
        applyAutomatically: input.applyAutomatically,
        actorAgentUserId: ctx.agentUserId,
        actorKeyType: ctx.keyType,
      })
    ),

  /**
   * "Sign in with Synap": may a person signed in to this app approve its OWN
   * agent's proposals from inside it (default true)? Owner only.
   */
  setSignInPolicy: protectedProcedure
    .input(
      z.object({
        publicId: PublicId,
        personMayDecideOwnAgentProposals: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) =>
      serializeApp(
        await setAppSignInPolicy({
          publicId: input.publicId,
          ownerUserId: ctx.userId,
          personMayDecideOwnAgentProposals:
            input.personMayDecideOwnAgentProposals,
          actorAgentUserId: ctx.agentUserId,
          actorKeyType: ctx.keyType,
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

  // ── Pod admin: every member's apps (the console's Apps page) ──────────────

  /**
   * EVERY app on the pod, whoever owns it — the console inventory. Pod admin
   * only; the self-scoped `list` above stays the member's own door. Each row
   * is the owner's wire row plus its keys, its owner and the names of the
   * spaces it reaches (`serializeAppsForAdmin`). Revoked apps are included
   * by default so an admin can remove them for good; removed apps never are.
   */
  adminList: podAdminProcedure
    .input(z.object({ includeRevoked: z.boolean().optional() }).optional())
    .query(async ({ input }) =>
      serializeAppsForAdmin(
        await new AppRepository(db).listAll({
          includeRevoked: input?.includeRevoked ?? true,
        })
      )
    ),

  /** One app by public id, whoever owns it — the console's app page. */
  adminGet: podAdminProcedure
    .input(z.object({ publicId: PublicId }))
    .query(async ({ input }) => {
      const found = await new AppRepository(db).getByPublicId(input.publicId);
      if (!found) {
        throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
      }
      const [row] = await serializeAppsForAdmin([found]);
      return row!;
    }),

  /**
   * Revoke anyone's app — the SAME service as `revoke`, with the owner floor
   * lifted (`podAdmin`). The event names the admin who did it.
   */
  adminRevoke: podAdminProcedure
    .input(z.object({ publicId: PublicId }))
    .mutation(async ({ ctx, input }) => {
      const { publicId } = await revokeApp({
        publicId: input.publicId,
        ownerUserId: ctx.userId,
        podAdmin: true,
      });
      return { revoked: true, publicId };
    }),

  /** Remove anyone's REVOKED app for good — the same service as `remove`. */
  adminRemove: podAdminProcedure
    .input(z.object({ publicId: PublicId }))
    .mutation(async ({ ctx, input }) => {
      const { publicId } = await removeApp({
        publicId: input.publicId,
        ownerUserId: ctx.userId,
        podAdmin: true,
      });
      return { removed: true, publicId };
    }),

  // ── Pod admin: pod apps across members + the policy (spec 17 PB4) ─────────

  /**
   * Every member's pod app connections, grouped by app ("Content Studio —
   * 3 members"). One member's connection opens through `adminGet` and ends
   * through `adminRevoke`; `adminRevokeClient` ends the app for everyone.
   */
  adminPodApps: podAdminProcedure.query(({ ctx }) => {
    refuseAgentCredential(ctx, "read every member's apps");
    return adminPodApps();
  }),

  /** End one pod app for EVERY member (each through `revokeApp`). */
  adminRevokeClient: podAdminProcedure
    .input(z.object({ clientId: z.string().url().max(512) }))
    .mutation(({ ctx, input }) =>
      adminRevokePodAppClient({
        oauthClientId: input.clientId,
        adminUserId: ctx.userId,
        actorAgentUserId: ctx.agentUserId,
        actorKeyType: ctx.keyType,
      })
    ),

  /**
   * The pod's pod-app policy (F4): may members connect apps that are not
   * Synap apps (default yes). `unverifiedLive` counts the connections such
   * apps hold now — the switch gates NEW connections only.
   */
  adminPolicy: podAdminProcedure.query(async ({ ctx }) => {
    refuseAgentCredential(ctx, "read the pod's app policy");
    return {
      ...(await readPodAppPolicy()),
      unverifiedLive: await countLiveUnverifiedConnections(),
    };
  }),

  adminSetPolicy: podAdminProcedure
    .input(z.object({ allowUnverified: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      refuseAgentCredential(ctx, "change the pod's app policy");
      return {
        ...(await setPodAppPolicy({
          allowUnverified: input.allowUnverified,
          changedBy: ctx.userId,
        })),
        unverifiedLive: await countLiveUnverifiedConnections(),
      };
    }),
});
