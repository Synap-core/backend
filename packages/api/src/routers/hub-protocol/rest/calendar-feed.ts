/**
 * Hub Protocol REST — personal ICS calendar feed.
 *
 * UNAUTH: GET /calendar/feed/:token.ics — token in the PATH is the capability.
 * AUTH:   GET/POST /calendar/feed, POST /calendar/feed/rotate
 *
 * Do not reuse resource_shares or Hub API keys as the feed secret.
 */

import { z } from "@hono/zod-openapi";
import {
  db,
  entities,
  entityExternalLinks,
  profiles,
  calendarFeedTokens,
  eq,
  and,
  isNull,
  inArray,
  notInArray,
  desc,
} from "@synap/database";

import { entityReadVisibleWhere } from "../../entities/helpers.js";
import { generateShareToken, hashToken } from "../../../utils/share-token.js";
import { openLink } from "../../../utils/deep-links.js";
import {
  buildSynapCalendarIcs,
  CALENDAR_PROFILE_SLUGS,
  type CalendarFeedEntity,
} from "../../../utils/calendar-ics.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import type { Context } from "hono";

/**
 * SECURITY — a personal calendar URL is not something an agent may mint.
 *
 * Mint/rotate/revoke are gated only by `hub-protocol.write`, which agent keys
 * hold. Without this an agent could issue a permanent, unauthenticated,
 * pod-wide read URL for its human owner (and rotation would silently kill the
 * owner's real subscription).
 *
 * This is a HARD REJECT rather than `checkPermissionOrPropose`, deliberately:
 * the plaintext token is returned exactly once, synchronously, to whoever made
 * the call. An approved proposal would hand the secret to the AGENT, not to
 * the human who approved it — the propose path cannot express this operation
 * safely. Same shape as `rejectAgentReviewer` in `_shared.ts`, which refuses
 * agent credentials on proposal review for the same "this is the human's step"
 * reason.
 */
function rejectAgentCredential(
  c: Context<{ Variables: HubVariables }>,
  action: "mint" | "rotate" | "revoke"
): Response | null {
  const agentUserId = c.get("agentUserId");
  if (!agentUserId) return null;
  logger.warn(
    { agentUserId, action },
    "agent credential attempted to change a personal calendar feed — blocked"
  );
  return c.json(
    {
      error:
        `An agent credential cannot ${action} a calendar feed URL. The feed is ` +
        "a personal secret and is shown once to the person who asks for it — " +
        `${action} it from a human session.`,
    },
    403
  );
}

const FeedStatusSchema = z
  .object({
    hasToken: z.boolean(),
    tokenPrefix: z.string().nullable(),
    createdAt: z.string().nullable(),
    lastAccessedAt: z.string().nullable(),
  })
  .openapi("CalendarFeedStatus");

const FeedMintSchema = z
  .object({
    url: z.string(),
    webcalUrl: z.string(),
  })
  .openapi("CalendarFeedMint");

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function publicUrlHost(): string | undefined {
  return (
    process.env.PUBLIC_URL?.replace(/^https?:\/\//i, "").replace(/\/$/, "") ||
    undefined
  );
}

/**
 * The host to PRINT in a freshly minted feed URL. Request-derived on purpose:
 * whoever is minting wants a URL on the hostname they are talking to.
 *
 * This is a rendering concern only. It must never reach a UID — see
 * `resolveUidNamespace`.
 */
function resolvePodHost(hostHeader: string | undefined): string {
  const fromEnv = publicUrlHost();
  if (fromEnv) return fromEnv;
  const raw = hostHeader || "localhost";
  return raw.split(",")[0]!.trim();
}

/**
 * Fallback right-hand side of a UID when `PUBLIC_URL` is unset.
 *
 * `.invalid` is reserved by RFC 2606 §2 precisely so a synthetic name can
 * never collide with a real host. Global uniqueness does not depend on it
 * anyway: the left-hand side is `entities.id`, a v4 UUID.
 */
const UID_NAMESPACE_FALLBACK = "synap.invalid";

/**
 * The right-hand side of every VEVENT UID. **Never request-derived.**
 *
 * RFC 5545 §3.8.4.7: a UID identifies the ITEM, not the rendering of it. When
 * this was `resolvePodHost(host header)`, a pod reachable at two hostnames
 * emitted two different UIDs for the same object — which a calendar client
 * reads as delete-plus-create, losing the user's local colour and alert
 * overrides and, if both URLs are subscribed, showing a phantom duplicate.
 *
 * Measured exposure at the time of the fix: LOW but real. `deploy/docker-
 * compose.yml` declares `PUBLIC_URL: ${PUBLIC_URL:?...}`, so a composed pod
 * cannot boot without it, and `deploy/Caddyfile` serves the API on exactly one
 * site block (`{$DOMAIN}`) — one deployed pod, one hostname. The request-
 * derived branch therefore only ever fired for a pod run outside compose
 * (local dev), and would have fired the day a second hostname was added.
 *
 * `PUBLIC_URL` is what this reuses because it is the only pod-identifying
 * value available synchronously — the same value `deep-links.ts` already
 * treats as the pod's identity. There is no immutable pod id to prefer: the
 * Control-Plane `podId` lives in a workspace `settings` JSONB row
 * (`routers/provision.ts:425`), needs an async DB read, and is absent on every
 * self-hosted pod.
 *
 * ⚠️ ONE-TIME COST: this changes the UID scheme, so every already-subscribed
 * client will delete its existing events and re-create them once. That is
 * worth paying now, while approximately nobody is subscribed, and is never
 * worth paying later — do not change this string again.
 */
function resolveUidNamespace(): string {
  return publicUrlHost() ?? UID_NAMESPACE_FALLBACK;
}

function feedUrls(
  podHost: string,
  token: string
): { url: string; webcalUrl: string } {
  const path = `/api/hub/calendar/feed/${token}.ics`;
  return {
    url: `https://${podHost}${path}`,
    webcalUrl: `webcal://${podHost}${path}`,
  };
}

function requireUser(userId: string | undefined): userId is string {
  return typeof userId === "string" && userId.length > 0;
}

async function liveTokenFor(userId: string) {
  return db.query.calendarFeedTokens.findFirst({
    where: and(
      eq(calendarFeedTokens.userId, userId),
      isNull(calendarFeedTokens.revokedAt)
    ),
  });
}

async function persistToken(userId: string, token: string) {
  const tokenLookupHash = hashToken(token);
  const tokenPrefix = token.slice(0, 8);
  const existing = await db.query.calendarFeedTokens.findFirst({
    where: eq(calendarFeedTokens.userId, userId),
  });
  const now = new Date();
  if (existing) {
    await db
      .update(calendarFeedTokens)
      .set({
        tokenLookupHash,
        tokenPrefix,
        createdAt: now,
        lastAccessedAt: null,
        revokedAt: null,
      })
      .where(eq(calendarFeedTokens.id, existing.id));
  } else {
    await db.insert(calendarFeedTokens).values({
      userId,
      tokenLookupHash,
      tokenPrefix,
      createdAt: now,
    });
  }
}

/**
 * Most rows one poll will ever read.
 *
 * The feed re-serializes its whole body on every poll (ICS has no incremental
 * sync) and a client polls every 5-15 minutes, so an unbounded read is a
 * per-user, per-device memory multiplier. 5000 dated objects inside a
 * ~13-month window is far past any real pod; a pod that exceeds it is telling
 * us the window needs to shrink, not that the ceiling should rise.
 */
const FEED_ROW_CEILING = 5000;

function asProps(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The provider string the Google Calendar import ACTUALLY writes into
 * `entity_external_links.provider`.
 *
 * It is `"google"`, not `"google-calendar"` — `GOOGLE_PROVIDER` in
 * `services/event-sync/run-gcal-import.ts` (and `migrate-gcal-events.ts`), fed
 * to `makeExternalLinkIdempotency().register()`, which is the only writer.
 * `"google-calendar"` appears in this repo ONLY inside comments
 * (`schema/entity-external-links.ts:31`, `schema/automations.ts:110`,
 * `automation-trigger-matcher.ts:526`) and would match zero rows — a filter
 * written from those comments would be silently inert.
 */
const GOOGLE_SYNC_PROVIDER = "google";

/**
 * Entity ids that came FROM Google Calendar (they carry a `google` external
 * link). The feed must not re-export them.
 *
 * A user can both connect Google Calendar (pulling its events in as `event`
 * entities) and subscribe Google to this ICS URL — two toggles one screen apart
 * in relay Settings. Our UID is `<entityId>@<podHost>`, which Google cannot
 * reconcile with its own event id, so it renders the same appointment a second
 * time, forever, with no way for the user to delete the copy (the feed is
 * read-only).
 *
 * Status is deliberately NOT filtered. A `disconnected` link still means the
 * event exists in Google's calendar as well as here, so re-exporting it would
 * still double-render; the link row is the durable "Google already owns this
 * occurrence" fact, not a liveness signal.
 *
 * Scoped to the profiles the feed reads anyway (task/event/meeting), so a later
 * Gmail/Drive sync landing under the same `google` provider — a registered
 * `SyncKindHandler` with `provider: "google"`, per `connection-sync.ts` — cannot
 * accidentally remove anything from the calendar.
 */
function googleSyncedEntityIds() {
  return db
    .select({ id: entityExternalLinks.entityId })
    .from(entityExternalLinks)
    .where(eq(entityExternalLinks.provider, GOOGLE_SYNC_PROVIDER));
}

async function loadOwnedCalendarEntities(
  userId: string
): Promise<CalendarFeedEntity[]> {
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      preview: entities.preview,
      properties: entities.properties,
      type: entities.type,
      profileSlug: profiles.slug,
      updatedAt: entities.updatedAt,
    })
    .from(entities)
    .innerJoin(profiles, eq(entities.profileId, profiles.id))
    .where(
      and(
        // FLOOR — unchanged, and kept even though ownership implies it. The
        // canonical read floor is never removed from a read; the ownership
        // conjunct below only NARROWS it.
        entityReadVisibleWhere(userId),
        // OWNERSHIP — the feed carries the TOKEN OWNER's own objects.
        //
        // The floor alone is the widest read predicate in the codebase: over an
        // UNAUTHENTICATED URL it exported every colleague's dated entity from
        // every shared workspace. There is no `ownedEntitiesWhere` helper —
        // ownership is expressed as a bare `eq(entities.userId, …)` everywhere
        // it is meant (hub.ts:144, discover.ts:390, retrieve.ts:159,
        // entities/read.ts:537), so that is the canonical spelling.
        //
        // This does NOT drop AI-created objects: an agent key resolves to its
        // `linkedUserId` (the human) in `_middleware/auth.ts`, so entities an
        // agent creates already carry the human's `userId`.
        eq(entities.userId, userId),
        isNull(entities.deletedAt),
        inArray(profiles.slug, [...CALENDAR_PROFILE_SLUGS]),
        notInArray(entities.id, googleSyncedEntityIds())
      )
    )
    // A hard ceiling on one poll. The date window that decides what actually
    // reaches the calendar lives in `buildSynapCalendarIcs` — it cannot be a
    // SQL predicate, because the date is a JSONB property with four possible
    // keys and no index. So this LIMIT is a memory bound, not the window:
    // newest-touched first, so an over-limit pod loses its stalest rows rather
    // than an arbitrary page.
    .orderBy(desc(entities.updatedAt))
    .limit(FEED_ROW_CEILING);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    preview: row.preview,
    properties: asProps(row.properties),
    type: row.type,
    profileSlug: row.profileSlug,
    updatedAt: row.updatedAt,
  }));
}

export function registerCalendarFeedRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/calendar/feed",
    tags: ["Calendar"],
    summary: "Calendar feed status (no plaintext token)",
    responses: {
      200: { description: "Feed status", schema: FeedStatusSchema },
      401: { description: "Unauthorized", schema: ErrorSchema },
      403: { description: "Missing scope", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/calendar/feed",
    tags: ["Calendar"],
    summary: "Mint a personal ICS feed URL (plaintext once)",
    responses: {
      200: { description: "Feed URLs", schema: FeedMintSchema },
      401: { description: "Unauthorized", schema: ErrorSchema },
      403: { description: "Missing scope", schema: ErrorSchema },
      409: { description: "Feed already exists", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/calendar/feed/rotate",
    tags: ["Calendar"],
    summary: "Revoke the live token and mint a new one",
    responses: {
      200: { description: "New feed URLs", schema: FeedMintSchema },
      401: { description: "Unauthorized", schema: ErrorSchema },
      403: { description: "Missing scope", schema: ErrorSchema },
      404: { description: "No live feed to rotate", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/calendar/feed/{token}.ics",
    tags: ["Calendar"],
    summary: "Personal ICS feed (token in path; unauthenticated)",
    security: [],
    responses: {
      200: { description: "text/calendar body" },
      404: { description: "Unknown or revoked token", schema: ErrorSchema },
    },
  });

  /**
   * GET /calendar/feed — AUTH. Status only; never returns plaintext.
   */
  app.get("/calendar/feed", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId");
    if (!requireUser(userId)) return c.json({ error: "Unauthenticated" }, 401);

    const row = await liveTokenFor(userId);
    return c.json({
      hasToken: Boolean(row),
      tokenPrefix: row?.tokenPrefix ?? null,
      createdAt: isoOrNull(row?.createdAt),
      lastAccessedAt: isoOrNull(row?.lastAccessedAt),
    });
  });

  /**
   * POST /calendar/feed — AUTH. Mint if none; plaintext URL once.
   */
  app.post("/calendar/feed", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const blocked = rejectAgentCredential(c, "mint");
    if (blocked) return blocked;
    const userId = c.get("userId");
    if (!requireUser(userId)) return c.json({ error: "Unauthenticated" }, 401);

    const existing = await liveTokenFor(userId);
    if (existing) {
      return c.json(
        { error: "A calendar feed already exists. Rotate to mint a new URL." },
        409
      );
    }

    const token = generateShareToken();
    await persistToken(userId, token);
    const podHost = resolvePodHost(
      c.req.header("x-forwarded-host") || c.req.header("host")
    );
    logger.info(
      { userId, tokenPrefix: token.slice(0, 8) },
      "calendar feed minted"
    );
    return c.json(feedUrls(podHost, token), 200);
  });

  /**
   * POST /calendar/feed/rotate — AUTH. Revoke old hash, mint new plaintext once.
   */
  app.post("/calendar/feed/rotate", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const blocked = rejectAgentCredential(c, "rotate");
    if (blocked) return blocked;
    const userId = c.get("userId");
    if (!requireUser(userId)) return c.json({ error: "Unauthenticated" }, 401);

    const existing = await liveTokenFor(userId);
    if (!existing) {
      return c.json({ error: "No calendar feed to rotate" }, 404);
    }

    const token = generateShareToken();
    await persistToken(userId, token);
    const podHost = resolvePodHost(
      c.req.header("x-forwarded-host") || c.req.header("host")
    );
    logger.info(
      { userId, tokenPrefix: token.slice(0, 8) },
      "calendar feed rotated"
    );
    return c.json(feedUrls(podHost, token), 200);
  });

  /**
   * DELETE /calendar/feed — AUTH. Turn the feed OFF.
   *
   * Rotation replaces a leaked URL; it cannot switch the feature off, and until
   * this existed `revokedAt` was written `null` and nothing else — so the
   * revoked branch in the reader below was unreachable code and a user who
   * changed their mind had no way out except deleting the row by hand.
   *
   * Revoking is idempotent: no live token is a 200 with `revoked: false`, not a
   * 404, because "there is nothing to turn off" is the state the caller wanted.
   */
  app.delete("/calendar/feed", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const blocked = rejectAgentCredential(c, "revoke");
    if (blocked) return blocked;
    const userId = c.get("userId");
    if (!requireUser(userId)) return c.json({ error: "Unauthenticated" }, 401);

    const existing = await liveTokenFor(userId);
    if (!existing) return c.json({ revoked: false });

    await db
      .update(calendarFeedTokens)
      .set({ revokedAt: new Date() })
      .where(eq(calendarFeedTokens.id, existing.id));
    logger.info(
      { userId, tokenPrefix: existing.tokenPrefix },
      "calendar feed revoked"
    );
    return c.json({ revoked: true });
  });

  /**
   * GET /calendar/feed/:token.ics — UNAUTH. Token in the path is the capability.
   */
  app.get("/calendar/feed/:token", async (c) => {
    const raw = c.req.param("token") ?? "";
    if (!raw.endsWith(".ics")) {
      return c.json({ error: "Not found" }, 404);
    }
    const token = raw.slice(0, -".ics".length);
    if (!token) return c.json({ error: "Not found" }, 404);

    const tokenLookupHash = hashToken(token);
    const row = await db.query.calendarFeedTokens.findFirst({
      where: eq(calendarFeedTokens.tokenLookupHash, tokenLookupHash),
    });
    if (!row || row.revokedAt) {
      return c.json({ error: "Not found" }, 404);
    }

    try {
      await db
        .update(calendarFeedTokens)
        .set({ lastAccessedAt: new Date() })
        .where(eq(calendarFeedTokens.id, row.id));
    } catch (err) {
      logger.warn(
        { err, tokenPrefix: row.tokenPrefix },
        "calendar feed lastAccessedAt failed"
      );
    }

    const visible = await loadOwnedCalendarEntities(row.userId);
    const { ics, maxUpdatedAt } = buildSynapCalendarIcs(
      visible,
      resolveUidNamespace(),
      { entityUrl: (id) => openLink(id) }
    );
    const tagSource = maxUpdatedAt ?? row.createdAt ?? new Date(0);
    const etag = `"${tagSource.getTime().toString(16)}"`;

    return c.body(ics, 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "private, max-age=300",
      ETag: etag,
    });
  });
}
