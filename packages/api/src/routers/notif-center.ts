/**
 * Notification Center Router
 *
 * Provides CRUD for the notifications table.
 * Mounted as trpc.notifCenter.* in root.ts.
 *
 * Separate from the legacy notifications router (inbox items from N8N).
 */

import { assertKeyMayWrite } from "../utils/assert-key-may-write.js";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import {
  db,
  notifications,
  notificationPreferences,
  eq,
  and,
  or,
  desc,
  count,
  inArray,
  isNull,
  isNotNull,
  lte,
  focusSessions,
} from "@synap/database";
import { NotificationStatus } from "@synap/database";
import { ScopeFilterShape, resolveScope } from "../utils/scope-filter.js";
import { requireUserId } from "../utils/user-scoped.js";
import {
  HANDOFF_DEVICES,
  HANDOFF_KINDS,
  OBJECT_NAV_VIEWS,
} from "@synap-core/types/navigation";
import { handOff, handoffReach } from "../services/handoff/handoff.js";
import { buildNotificationCatalogue } from "../notifications/catalogue.js";
import {
  resolveEffectivePrefs,
  shadowingWorkspaceIds,
} from "../notifications/preference-scope.js";
import {
  PUSH_CATEGORIES,
  effectivePushCategories,
  type PushPrefs,
} from "@synap-core/types/push";
import {
  readPushPrefs,
  writePushPrefs,
  writeSessionMute,
} from "../notifications/push-prefs.js";
import {
  listPushDevices,
  registerPushDevice,
  revokePushDevice,
  unregisterPushDevice,
} from "../notifications/push-devices.js";
import { containerNotificationWhere } from "../services/signals/lens-containers.js";
import {
  rosterReadFor,
  sessionReadableWhere,
} from "../access/session-visibility.js";

/** What a phone's push settings render — every category, effective state. */
function pushPrefsView(prefs: PushPrefs) {
  return { categories: effectivePushCategories(prefs) };
}

/**
 * Flip any DUE snoozes (snoozedUntil now past) back to `unread` for this user,
 * across all workspaces. Called lazily at the top of every read door so a woken
 * item reappears in the bell without a dedicated cron. A 0-row UPDATE is cheap —
 * it is served by the partial index `notifs_snoozed_until_idx` (migration 0226).
 */
async function wakeDueSnoozes(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ status: NotificationStatus.UNREAD, snoozedUntil: null })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.status, NotificationStatus.SNOOZED),
        lte(notifications.snoozedUntil, new Date())
      )
    );
}

/**
 * Adding, re-enabling or turning off a phone is the person's act: an agent
 * key is refused, and any other key is bounded by its grant.
 */
async function assertPersonOwnsPhones(agentUserId: string | null | undefined) {
  if (agentUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only the person can change which phones get their notifications.",
    });
  }
  await assertKeyMayWrite({ subjectType: "preference", action: "update" });
}

export { HANDOFF_DEDUP_WINDOW_MS } from "../services/handoff/handoff.js";

export const notifCenterRouter = router({
  /**
   * THE one door for notifications (collapses the old list/listAll split).
   *
   * Notifications are user-owned (the `userId` field is the recipient), so the
   * floor is `eq(userId)` — every door for this table starts there. The
   * workspace lens then NARROWS within the user's own rows:
   *   - no `workspaceId` (and no active-ws header) → ALL my notifications
   *   - active-ws header / a `workspaceId` → that workspace's notifications
   *   - `workspaceId: null` → pod-wide (workspaceId IS NULL) notifications
   *   - `workspaceId: [a, b]` → those workspaces (union)
   * No project axis (notifications aren't project-scoped). Default: unread only.
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: ScopeFilterShape.workspaceId,
        status: z
          .enum(["unread", "read", "dismissed", "snoozed", "all"])
          .default("unread"),
        category: z
          .enum(["governance", "data", "ai", "system", "inbox"])
          .optional(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
        /**
         * Only rows whose subject sits INSIDE this container — a session in
         * it (or a message in such a session's room), read through the
         * session read floor (`containerNotificationWhere`). Applied in SQL
         * BEFORE the limit, so a narrow lens reads its own rows, not the
         * newest N of the whole pod. Each key only ANDs.
         */
        container: z
          .object({
            sessionId: z.string().uuid().optional(),
            trackId: z.string().uuid().optional(),
            projectId: z.string().uuid().optional(),
          })
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // Surface any due snoozes before reading (flips them back to unread).
      await wakeDueSnoozes(userId);
      const { workspaceLens } = resolveScope(ctx, input);
      const conditions = [eq(notifications.userId, userId)];
      const inContainer = input.container
        ? containerNotificationWhere(input.container, {
            userId,
            roster: rosterReadFor(ctx),
          })
        : undefined;
      if (inContainer) conditions.push(inContainer);

      // Workspace lens narrows within the user's own rows (the floor is userId).
      if (workspaceLens === null) {
        conditions.push(isNull(notifications.workspaceId));
      } else if (Array.isArray(workspaceLens)) {
        if (workspaceLens.length > 0) {
          conditions.push(inArray(notifications.workspaceId, workspaceLens));
        }
      } else if (typeof workspaceLens === "string") {
        conditions.push(eq(notifications.workspaceId, workspaceLens));
      }

      if (input.status !== "all") {
        conditions.push(eq(notifications.status, input.status));
      }

      if (input.category) {
        conditions.push(eq(notifications.category, input.category));
      }

      const rows = await db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      return { notifications: rows, total: rows.length };
    }),

  /**
   * Total unread count for the bell badge.
   */
  unreadCount: workspaceProcedure.query(async ({ ctx }) => {
    // Wake due snoozes first so the badge counts them (0-row UPDATE when none).
    await wakeDueSnoozes(ctx.userId);
    // COUNT(*) in the DB — was materializing up to 100 id rows then taking
    // .length (which also silently capped the badge at 100). This is polled
    // frequently (bell badge); the aggregate is served entirely from the
    // partial index `notifs_unread_user_workspace_idx` (migration 0122).
    const [row] = await db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          // POD-WIDE notifications carry `workspace_id IS NULL`, and SQL `=`
          // NEVER matches NULL — so an `eq(workspaceId, ctx.workspaceId)` filter
          // silently excluded every one of them and the bell never badged for
          // pod-wide governance attention (the one path that has no workspace to
          // belong to). They are not workspace-scoped, so they count in EVERY
          // lens; the user floor below is what actually protects them.
          or(
            eq(notifications.workspaceId, ctx.workspaceId),
            isNull(notifications.workspaceId)
          ),
          eq(notifications.userId, ctx.userId),
          eq(notifications.status, NotificationStatus.UNREAD)
        )
      );

    return { count: row?.value ?? 0 };
  }),

  /**
   * Mark a single notification as read.
   */
  markRead: protectedProcedure
    .input(z.object({ notificationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(notifications)
        .set({ status: NotificationStatus.READ, readAt: new Date() })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            // Inbox is user-wide. An item from another Space stays actionable
            // after the active lens changes; user ownership is the security floor.
            eq(notifications.userId, requireUserId(ctx.userId))
          )
        );
      return { success: true };
    }),

  /**
   * Mark all unread notifications as read.
   */
  markAllRead: workspaceProcedure.mutation(async ({ ctx }) => {
    await db
      .update(notifications)
      .set({ status: NotificationStatus.READ, readAt: new Date() })
      .where(
        and(
          // Same NULL-scope bug as `unreadCount`: pod-wide notifications carry
          // `workspace_id IS NULL` and SQL `=` NEVER matches NULL, so "mark all
          // read" left every pod-wide governance item unread forever — the badge
          // counts them (post-fix) but this door could never clear them. They
          // belong to no workspace, so they are in scope from EVERY lens; the
          // userId floor below is what actually protects the row.
          or(
            eq(notifications.workspaceId, ctx.workspaceId),
            isNull(notifications.workspaceId)
          ),
          eq(notifications.userId, ctx.userId),
          eq(notifications.status, NotificationStatus.UNREAD)
        )
      );
    return { success: true };
  }),

  /**
   * Dismiss a notification (soft-delete from bell).
   */
  dismiss: workspaceProcedure
    .input(z.object({ notificationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(notifications)
        .set({ status: NotificationStatus.DISMISSED })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.userId, ctx.userId),
            // Same NULL-scope bug as `unreadCount`. Here it made dismiss a LYING
            // MUTATION: a pod-wide row (`workspace_id IS NULL`) matched 0 rows,
            // the door still returned `{success:true}`, and the item reappeared
            // on the next poll. Pod-wide items are dismissable from every lens;
            // the id + userId floor above is the real protection.
            or(
              eq(notifications.workspaceId, ctx.workspaceId),
              isNull(notifications.workspaceId)
            )
          )
        );
      return { success: true };
    }),

  /**
   * Dismiss all notifications (clear bell).
   */
  dismissAll: workspaceProcedure.mutation(async ({ ctx }) => {
    await db
      .update(notifications)
      .set({ status: NotificationStatus.DISMISSED })
      .where(
        and(
          // Same NULL-scope bug as `unreadCount` / `dismiss`: "clear bell" left
          // every pod-wide (`workspace_id IS NULL`) item behind while claiming
          // success. Pod-wide items belong to no workspace, so they clear from
          // any lens; the userId floor below is what protects them.
          or(
            eq(notifications.workspaceId, ctx.workspaceId),
            isNull(notifications.workspaceId)
          ),
          eq(notifications.userId, ctx.userId),
          eq(notifications.status, NotificationStatus.UNREAD)
        )
      );
    return { success: true };
  }),

  /**
   * Snooze a notification until `until` (triage-defer). Hidden from the active
   * unread list until then; `wakeDueSnoozes` flips it back to unread on the next
   * read. User-owned floor (`eq(userId)`) — snoozeable from any lens.
   */
  snooze: protectedProcedure
    .input(
      z.object({
        notificationId: z.string().uuid(),
        until: z.string().datetime(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .update(notifications)
        .set({
          status: NotificationStatus.SNOOZED,
          snoozedUntil: new Date(input.until),
        })
        .where(
          and(
            eq(notifications.id, input.notificationId),
            eq(notifications.userId, requireUserId(ctx.userId))
          )
        );
      return { success: true };
    }),

  /**
   * The per-type notification CATALOGUE — what a settings picker renders FROM.
   *
   * `protectedProcedure`, not `workspaceProcedure`: the registry is a property
   * of the pod build, identical in every workspace, and preferences written
   * through `updatePrefs` are pod-wide by default. Requiring a workspace header
   * would imply a lens this answer does not have.
   *
   * Pure and cheap (no DB). It exposes only PRODUCER-BACKED types and only
   * channels with a real transport — see `notifications/catalogue.ts` for why
   * each exclusion exists and what the projection deliberately does NOT cover.
   */
  types: protectedProcedure.query(() => buildNotificationCatalogue()),

  /**
   * Notification preferences for the current user.
   *
   * Returns the EFFECTIVE row under the same precedence
   * `NotificationService.create` applies — the workspace override first, the
   * pod-wide row (`workspaceId IS NULL`) as the fallback. This door previously
   * read the workspace row ALONE, so a founder whose preferences live on the
   * pod-wide row saw them as unset in every workspace.
   *
   * SHAPE: the effective row's own columns are spread at the top level, so every
   * existing reader (relay's quiet-hours screen, synap-app's
   * `NotificationPreferences.tsx`) keeps working unchanged. The scope fields are
   * ADDITIVE. `null` still means "no row anywhere" — genuinely nothing
   * configured, and distinct from a failed read, which throws.
   */
  getPrefs: workspaceProcedure.query(async ({ ctx }) => {
    const [workspaceRow, podRow] = await Promise.all([
      db.query.notificationPreferences.findFirst({
        where: and(
          eq(notificationPreferences.userId, ctx.userId),
          eq(notificationPreferences.workspaceId, ctx.workspaceId)
        ),
      }),
      db.query.notificationPreferences.findFirst({
        where: and(
          eq(notificationPreferences.userId, ctx.userId),
          isNull(notificationPreferences.workspaceId)
        ),
      }),
    ]);

    const { row, scope } = resolveEffectivePrefs(
      podRow ?? null,
      workspaceRow ?? null
    );
    if (!row) return null;

    return {
      ...row,
      /** Which row this answer came from — "pod" or "workspace". */
      effectiveScope: scope,
      /**
       * True when a workspace override is shadowing the pod-wide row in THIS
       * workspace. A settings surface should say so rather than present the
       * override as if it were the pod-wide setting.
       */
      shadowedByWorkspaceOverride: scope === "workspace" && Boolean(podRow),
    };
  }),

  /**
   * Update notification preferences.
   *
   * POD-WIDE BY DEFAULT (`scope: "pod"`). This used to write `ctx.workspaceId`
   * unconditionally, so a quiet-hour window or a routing rule set from relay
   * applied to exactly ONE workspace, silently.
   *
   * Nothing is migrated and no existing row is touched: the reader's precedence
   * is unchanged, so a workspace override the founder already set keeps winning
   * inside its workspace. That shadow is REPORTED — `shadowingWorkspaceIds`
   * names every workspace where this pod-wide write will not take effect — and
   * `clearWorkspaceOverride` is the door that drops one. Reconciling by deleting
   * overrides here would destroy a preference the founder set on purpose;
   * reconciling silently would hide one they cannot reach.
   */
  updatePrefs: workspaceProcedure
    .input(
      z.object({
        /**
         * Where the write lands. Omit for the pod-wide row — a caller that
         * means a single workspace must say so.
         */
        scope: z.enum(["pod", "workspace"]).default("pod"),
        enabled: z.boolean().optional(),
        quietHoursEnabled: z.boolean().optional(),
        quietHoursStart: z.string().optional(),
        quietHoursEnd: z.string().optional(),
        soundEnabled: z.boolean().optional(),
        routingRules: z.record(z.string(), z.any()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // How the person is interrupted is theirs — never an agent key's.
      if (ctx.agentUserId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the person can change their notification settings.",
        });
      }
      await assertKeyMayWrite({
        subjectType: "preference",
        action: "update",
      });
      const { scope, ...values } = input;
      const targetWorkspaceId = scope === "pod" ? null : ctx.workspaceId;

      const existing = await db.query.notificationPreferences.findFirst({
        where: and(
          eq(notificationPreferences.userId, ctx.userId),
          targetWorkspaceId === null
            ? isNull(notificationPreferences.workspaceId)
            : eq(notificationPreferences.workspaceId, targetWorkspaceId)
        ),
      });

      if (existing) {
        await db
          .update(notificationPreferences)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(notificationPreferences.id, existing.id));
      } else {
        await db.insert(notificationPreferences).values({
          userId: ctx.userId,
          workspaceId: targetWorkspaceId,
          ...values,
        });
      }

      // Only a pod-wide write can be shadowed; a workspace write IS the winner.
      const shadowedBy =
        scope === "pod"
          ? shadowingWorkspaceIds(
              await db
                .select({
                  workspaceId: notificationPreferences.workspaceId,
                })
                .from(notificationPreferences)
                .where(
                  and(
                    eq(notificationPreferences.userId, ctx.userId),
                    isNotNull(notificationPreferences.workspaceId)
                  )
                )
            )
          : [];

      return { success: true, scope, shadowingWorkspaceIds: shadowedBy };
    }),

  /**
   * Drop this workspace's override row so the pod-wide preferences apply here
   * again. The ONE way out of the shadow `updatePrefs` reports; without it a
   * pod-wide preference set from relay would be permanently unreachable in any
   * workspace that already had a row.
   *
   * Deletes only the caller's own `(userId, workspaceId)` row and never touches
   * the pod-wide row.
   */
  clearWorkspaceOverride: workspaceProcedure.mutation(async ({ ctx }) => {
    const deleted = await db
      .delete(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, ctx.userId),
          eq(notificationPreferences.workspaceId, ctx.workspaceId)
        )
      )
      .returning({ id: notificationPreferences.id });
    return { success: true, cleared: deleted.length > 0 };
  }),

  // ── Push categories ─────────────────────────────────────────────────────
  //
  // `protectedProcedure`: push categories are PERSON-scoped (their pod-wide
  // row), not workspace-scoped — see `notifications/push-prefs.ts`. The floor
  // is `ctx.userId`: a person reads and writes only their own row. An agent
  // key is refused on the write: how the person is interrupted is theirs.

  /**
   * Every push category with its effective state (`enabled`, `explicit` = the
   * person set it, `defaultOn`, `level`). Defaults
   * come from `@synap-core/types/push`. A failed read THROWS (isError) — it is
   * never answered with the defaults.
   */
  pushPrefs: protectedProcedure.query(async ({ ctx }) =>
    pushPrefsView(await readPushPrefs(requireUserId(ctx.userId)))
  ),

  /**
   * Turn push categories on/off. Sparse and merged in SQL: categories not
   * named are left as stored.
   */
  setPushPrefs: protectedProcedure
    .input(
      z.object({
        // `partialRecord`: zod 4's `record` over an enum key is EXHAUSTIVE
        // (every category required), which refused every real toggle.
        categories: z
          .partialRecord(z.enum(PUSH_CATEGORIES), z.boolean())
          .refine((c) => Object.keys(c).length > 0, "Nothing to change."),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.agentUserId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the person can change their push settings.",
        });
      }
      await assertKeyMayWrite({
        subjectType: "preference",
        action: "update",
      });
      const prefs = await writePushPrefs(requireUserId(ctx.userId), input);
      return pushPrefsView(prefs);
    }),

  /**
   * Mute or unmute ONE session's pushes (plan d679e92c C9). Muted, nothing
   * about that session rings the person's phone (devbox jobs, dev signals,
   * room activity, its asks); nothing is hidden either: its rows still land in
   * the bell and an owed ask stays in needs-you. Person-only, like the push
   * categories. A session the person may not read is NOT_FOUND (missing and
   * not-yours are the same answer). The session read carries the state back
   * as `continuation.muted`.
   */
  setSessionMute: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid(), muted: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertKeyMayWrite({
        subjectType: "preference",
        action: "update",
      });
      const userId = requireUserId(ctx.userId);
      const [session] = await db
        .select({ id: focusSessions.id })
        .from(focusSessions)
        .where(
          and(
            eq(focusSessions.id, input.sessionId),
            sessionReadableWhere({ userId, roster: rosterReadFor(ctx) })
          )
        )
        .limit(1);
      const muted = await writeSessionMute(userId, session!.id, input.muted);
      return { sessionId: session.id, muted };
    }),

  // ── Push devices ────────────────────────────────────────────────────────
  //
  // WHY THIS ROUTER. `relay-app` reaches the pod over tRPC through its pod
  // client and makes no Hub REST calls at all, so a Hub `/api/hub/*` door would
  // be unreachable from the one client that needs it. And a registered device
  // is a NOTIFICATION-DELIVERY fact, not a workspace object: it belongs beside
  // `getPrefs`/`updatePrefs`, which is where the rest of "how do I want to be
  // reached" already lives.
  //
  // These are `protectedProcedure`, not `workspaceProcedure`: a phone is owned
  // by a USER across every workspace (and pod-wide notifications have no
  // workspace at all), so requiring a workspace header would scope a device to
  // a lens it does not belong to.

  /**
   * Register or refresh this phone's Expo push token — the app calls it on
   * every launch (`everyLaunch: true`), which is what makes "last seen" true.
   * Answers the row's id and status:
   *   `connected` — pushes reach this phone;
   *   `revoked`   — the person turned this phone off from another device. It
   *                 stays off until they turn push on FROM THIS PHONE, which
   *                 sends `reenable: true` (`push-devices.ts`).
   * Only the person: an agent key may not add a delivery address for their
   * notifications, nor turn a phone back on.
   */
  registerDevice: protectedProcedure
    .input(
      z.object({
        // Expo's own token format. Validated so a malformed value cannot be
        // stored and then silently fail on every send forever.
        token: z
          .string()
          .regex(
            /^Expo(nent)?PushToken\[[^\]]+\]$/,
            "Must be an Expo push token, e.g. ExponentPushToken[...]"
          ),
        platform: z.enum(["ios", "android"]),
        deviceName: z.string().max(200).optional(),
        appVersion: z.string().max(50).optional(),
        reenable: z.boolean().optional(),
        everyLaunch: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertPersonOwnsPhones(ctx.agentUserId);
      const device = await registerPushDevice({
        userId: requireUserId(ctx.userId),
        ...input,
      });
      return { success: true, ...device };
    }),

  /**
   * This phone signing out: `disconnected`, never a delete, so the row still
   * absorbs a re-register on the same device. A phone turned off from
   * elsewhere stays `revoked`. Owner-floored by the token the phone holds.
   */
  unregisterDevice: protectedProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const revoked = await unregisterPushDevice({
        userId: requireUserId(ctx.userId),
        token: input.token,
      });
      // `revoked: false` means there was nothing to revoke — reported rather
      // than dressed up as a success.
      return { success: true, revoked };
    }),

  /**
   * Stop notifications to one of the caller's phones, from any other device
   * (the console's `/my-notifications`, or another phone). The phone stays
   * off until it is turned back on from that phone (`registerDevice` with
   * `reenable`).
   *
   * Owner-floored: only the caller's own phones. Another person's phone and a
   * missing one answer the SAME `NOT_FOUND` — a pod admin has no reach here.
   * An agent key is refused: how the person is reached is theirs.
   */
  revokeDevice: protectedProcedure
    .input(z.object({ id: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await assertPersonOwnsPhones(ctx.agentUserId);
      const device = await revokePushDevice({
        userId: requireUserId(ctx.userId),
        id: input.id,
      });
      if (!device) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Phone not found." });
      }
      return device;
    }),

  /**
   * The caller's phones (`PushDeviceRow`, `@synap-core/types/push`): name,
   * platform, app version, status, last seen. Floored on the caller's own
   * `userId`; the push TOKEN is never returned (a delivery credential). A
   * phone passes its own `token` to learn which row is itself.
   */
  listDevices: protectedProcedure
    .input(z.object({ token: z.string().max(300).optional() }).optional())
    .query(async ({ ctx, input }) =>
      listPushDevices({
        userId: requireUserId(ctx.userId),
        token: input?.token,
      })
    ),

  /**
   * THE handoff door (decision D5, be431bee): the person asks their OTHER
   * device to pick up an object — `to: "desktop"` ("Continue on desktop",
   * from relay) or `to: "phone"` ("Send to phone", from the desktop; where the
   * verb shows: plan call 11, d28ab079).
   *
   * A pointer, never a URL: `{kind, id, view?}` with `kind` one of
   * `HANDOFF_KINDS` (`@synap-core/types/navigation`; a client folds its own
   * spelling with `canonicalNavKind` first). Stored as one notification
   * (`services/handoff/handoff.ts`): a desktop gets it live or unread in its
   * inbox; a phone gets a push when it has one, else finds it in the app.
   *
   * The answer says the request was STORED, and `reach` says what the pod
   * knows of the person's devices of that class — never that one opened it.
   * The object must be one the person can read (its own read floor); someone
   * else's and a missing one answer the SAME `NOT_FOUND`.
   */
  handoff: protectedProcedure
    .input(
      z.object({
        target: z.object({
          kind: z.enum(HANDOFF_KINDS),
          id: z.string().uuid(),
          /** Only where it applies: `room` for a session. */
          view: z.enum(OBJECT_NAV_VIEWS).optional(),
        }),
        to: z.enum(HANDOFF_DEVICES),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // A handoff is a PERSON asking their own device to pick something up —
      // a device act. An agent key cannot make that ask on their behalf.
      if (ctx.agentUserId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only you can send something to your other device — an agent can't ask for this on your behalf.",
        });
      }
      await assertKeyMayWrite({
        subjectType: "notification",
        action: "create",
      });
      return handOff(requireUserId(ctx.userId), input);
    }),

  /**
   * Which of the person's device classes the pod can reach, read BEFORE a
   * handoff so the button says where it goes ("No desktop signed in" rather
   * than a "Sent" into the void). From their Synap app sign-ins
   * (`person_devices`) and, for a phone, its push registration. A hint for
   * the words, never a gate. Owner-floored: the caller's own devices only.
   */
  handoffTargets: protectedProcedure.query(async ({ ctx }) =>
    handoffReach(requireUserId(ctx.userId))
  ),

  /**
   * "Continue on desktop", the first door: a session (view `room`) or a
   * Library group. Kept as a thin wrapper over {@link handoff} until relay's
   * pin passes the new door; same answer shape as before (`status`,
   * `notificationId`). New callers use `handoff`.
   */
  requestHandoff: protectedProcedure
    .input(
      z.object({
        target: z.object({
          kind: z.enum(["session", "library_group"]),
          id: z.string().uuid(),
        }),
        /** `room` for a session; a Library group has no view. */
        view: z.enum(OBJECT_NAV_VIEWS).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const isGroup = input.target.kind === "library_group";
      if (isGroup ? input.view !== undefined : input.view !== "room") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: isGroup
            ? "A Library group opens as itself — no view."
            : "A session opens in its room (view: room).",
        });
      }
      if (ctx.agentUserId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only you can send a run to your desktop — an agent can't ask for this on your behalf.",
        });
      }
      await assertKeyMayWrite({
        subjectType: "notification",
        action: "create",
      });
      const result = await handOff(requireUserId(ctx.userId), {
        target: { ...input.target, view: input.view },
        to: "desktop",
      });
      return { status: result.status, notificationId: result.notificationId };
    }),
});
