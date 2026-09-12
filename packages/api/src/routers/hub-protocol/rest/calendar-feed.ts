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
  profiles,
  calendarFeedTokens,
  eq,
  and,
  isNull,
  inArray,
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
import { hasScope, logger, type HubHono } from "./_shared.js";

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

function resolvePodHost(hostHeader: string | undefined): string {
  const fromEnv = process.env.PUBLIC_URL?.replace(/^https?:\/\//i, "").replace(
    /\/$/,
    ""
  );
  if (fromEnv) return fromEnv;
  const raw = hostHeader || "localhost";
  return raw.split(",")[0]!.trim();
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

function asProps(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

async function loadVisibleCalendarEntities(
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
        entityReadVisibleWhere(userId),
        isNull(entities.deletedAt),
        inArray(profiles.slug, [...CALENDAR_PROFILE_SLUGS])
      )
    );

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

    const podHost = resolvePodHost(
      c.req.header("x-forwarded-host") || c.req.header("host")
    );
    const visible = await loadVisibleCalendarEntities(row.userId);
    const { ics, maxUpdatedAt } = buildSynapCalendarIcs(visible, podHost, {
      entityUrl: (id) => openLink(id),
    });
    const tagSource = maxUpdatedAt ?? row.createdAt ?? new Date(0);
    const etag = `"${tagSource.getTime().toString(16)}"`;

    return c.body(ics, 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "private, max-age=300",
      ETag: etag,
    });
  });
}
