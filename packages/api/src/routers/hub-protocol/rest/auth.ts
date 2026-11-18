/**
 * Hub Protocol REST — auth introspection.
 *
 * `GET /auth/status` — when called with a valid bearer key, returns the
 * introspection of that key (id, scopes, expiry, owning user). External
 * operators (Eve CLI, custom integrations) use this to verify
 * what their key can do BEFORE attempting privileged calls.
 *
 * The endpoint is auth-gated by the same middleware as the rest of
 * `/api/hub/*` — there's no "ping with junk credentials and get a hint"
 * path, because that would leak which keys exist on the pod.
 *
 * `GET /auth/grant` answers what the calling credential HOLDS, by place: an
 * app's token reads its own grant to explain itself ("this app can see…").
 * The grant is the one the hub middleware entered for this request, so a
 * token never sees another's.
 *
 * `GET /auth/key-state` is the ONE exception, on purpose: it answers the
 * holder of a key that does NOT authenticate — awaiting approval, replaced,
 * expired — so a CLI can say which fix applies. It is looked up by the
 * presented secret only (`services/key-holder-state.ts`); a secret the pod
 * never issued gets `{ state: "unknown" }`, at the cost of today's 401.
 *
 * (`POST /auth/exchange`, the RFC 7523 JWT-Bearer grant that minted a Kratos
 * session, was deleted in W6 2026-10-11: Kratos v1.3.1 has no admin
 * session-create route, so it never succeeded. Every client signs in through
 * Kratos OIDC `cp` instead.)
 */

import { createRoute } from "@hono/zod-openapi";
import {
  db,
  apiKeys,
  users,
  eq,
  getRequestGrant,
  inArray,
} from "@synap/database";
import { workspaces } from "@synap/database/schema";

import { authErrorResponse, shortenKeyId } from "../../../utils/auth-error.js";
import { describeKeyForHolder } from "../../../services/key-holder-state.js";
import { extractBearerToken } from "../_middleware/auth.js";
import { apiKeyService } from "../../../services/api-keys.js";
import {
  describeOwnGrant,
  grantSpaceIds,
  summarizeKeyGrant,
} from "../../../services/key-grant.js";
import {
  GUEST_REFUSED_BODY,
  isGuestPrincipal,
} from "../../../access/guest-containment.js";
import { reportNoPodAccess } from "../../../access/pod-access.js";
import {
  AuthStatusSchema,
  KeyHolderStateSchema,
  OwnGrantSchema,
} from "./_codecs/auth.js";
import { ErrorSchema, trpcErrorResponses } from "./_codecs/_openapi.js";
import { logger, type HubHono, httpStatusForTrpcError } from "./_shared.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerAuthRoutes(app: HubHono): void {
  const authStatusRoute = createRoute({
    method: "get",
    path: "/auth/status",
    tags: ["Auth"],
    summary: "Introspect the calling bearer credential",
    description:
      "Returns metadata about the API key that authenticated this request — " +
      "id, owning user, scopes, expiry, last-used-at, and `access` (the " +
      "key's grant: full access or what limits it). Used by Eve CLI and " +
      "external operators to verify their credential without making " +
      "privileged calls. Returns 401 if no valid bearer was supplied.",
    security: [{ bearerAuth: [] }],
    responses: {
      ...trpcErrorResponses,
      200: {
        description: "Bearer credential introspection.",
        content: { "application/json": { schema: AuthStatusSchema } },
      },
      401: { $ref: "#/components/responses/Unauthorized" },
      403: {
        description:
          "Forbidden — bearer is not an API key (e.g. session-token caller)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description:
          "Key was accepted by the auth middleware but its row was deleted concurrently.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(authStatusRoute, async (c) => {
    const apiKeyId = c.get("apiKeyId");
    const userId = c.get("userId");
    const grant = getRequestGrant();

    // The middleware sets `apiKeyId` only on the bearer-auth path. Session-
    // token callers (X-Session-Token) reach this handler with a userId but
    // no apiKeyId — there's nothing to introspect. Return 403 so clients
    // can tell the difference between "not authenticated" and "authenticated
    // but with the wrong credential type for this endpoint".
    if (!apiKeyId) {
      return c.json(
        {
          error:
            "/auth/status requires a Bearer API key. Session-token callers have no introspectable key.",
        },
        403
      );
    }
    if (!userId) {
      // Defensive — middleware is supposed to set userId alongside apiKeyId.
      return c.json(
        { error: "Internal error: missing userId on context" },
        500
      );
    }

    try {
      const [row] = await db
        .select({
          keyId: apiKeys.id,
          userId: apiKeys.userId,
          name: apiKeys.keyName,
          scope: apiKeys.scope,
          createdAt: apiKeys.createdAt,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          parentKeyId: apiKeys.parentKeyId,
          isActive: apiKeys.isActive,
          keyType: apiKeys.keyType,
          workspaceId: apiKeys.workspaceId,
          userEmail: users.email,
          userName: users.name,
        })
        .from(apiKeys)
        .leftJoin(users, eq(users.id, apiKeys.userId))
        .where(eq(apiKeys.id, apiKeyId));

      if (!row) {
        // The key passed validation moments ago but the row vanished — most
        // likely a concurrent revoke + cascade delete. Tell the caller in
        // structured form rather than a confusing 500.
        return c.json(
          { error: "API key row not found (revoked concurrently?)" },
          404
        );
      }

      // Drizzle returns Date objects for timestamp columns; the wire schema
      // declares ISO strings. Convert here so the response shape matches.
      return c.json(
        {
          keyId: row.keyId,
          keyIdPrefix: shortenKeyId(row.keyId) ?? "",
          userId: row.userId,
          userEmail: row.userEmail ?? null,
          userName: row.userName ?? null,
          name: row.name ?? null,
          scopes: (row.scope ?? []) as string[],
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
          parentKeyId: row.parentKeyId ?? null,
          isActive: row.isActive,
          keyType: row.keyType,
          workspaceId: row.workspaceId ?? null,
          // The grant the hub middleware entered for THIS request
          // (`runWithGrant`) — the one the write gates read, not a re-query.
          access: grant ? summarizeKeyGrant(grant) : null,
        },
        200
      );
    } catch (err) {
      logger.error({ err, apiKeyId }, "/auth/status lookup failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      ) as never;
    }
  });

  const ownGrantRoute = createRoute({
    method: "get",
    path: "/auth/grant",
    tags: ["Auth"],
    summary: "What the calling credential holds, by place",
    description:
      "Returns the calling credential's own grant — the one the pod enforces " +
      "on this request — as parts of permissions, each with the place it " +
      "reaches: `pod` (reads everywhere in the pod: an app's pod-wide reads), " +
      "`spaces` (named, with their names) or `anywhere`. An app reads it to " +
      "say what it can see. Read-only; never another credential's grant. " +
      "403 for a caller with no key (a signed-in session holds the person's " +
      "own reach, not a grant).",
    security: [{ bearerAuth: [] }],
    responses: {
      ...trpcErrorResponses,
      200: {
        description: "The calling credential's grant.",
        content: { "application/json": { schema: OwnGrantSchema } },
      },
      401: { $ref: "#/components/responses/Unauthorized" },
      403: {
        description: "Forbidden — the caller holds no key grant",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  app.openapi(ownGrantRoute, async (c) => {
    // The grant the hub middleware entered for THIS request (`runWithGrant`):
    // the one every gate reads, never a lookup by an id the caller sends.
    const grant = getRequestGrant();
    if (!c.get("apiKeyId") || !grant) {
      return c.json(
        {
          error:
            "/auth/grant describes a key's grant. A signed-in session holds your own reach, not a grant.",
        },
        403
      );
    }
    try {
      // Ids as stored; only uuid-shaped ones are looked up (a name, never a row).
      const ids = grantSpaceIds(grant).filter((id) => UUID_RE.test(id));
      const named =
        ids.length > 0
          ? await db
              .select({ id: workspaces.id, name: workspaces.name })
              .from(workspaces)
              .where(inArray(workspaces.id, ids))
          : [];
      return c.json(
        describeOwnGrant(grant, new Map(named.map((w) => [w.id, w.name]))),
        200
      );
    } catch (err) {
      logger.error({ err }, "/auth/grant failed");
      return c.json(
        { error: "Could not read this credential's grant" },
        httpStatusForTrpcError(err)
      ) as never;
    }
  });

  const keyStateRoute = createRoute({
    method: "get",
    path: "/auth/key-state",
    tags: ["Auth"],
    summary: "Why the presented key does or does not work (holder only)",
    description:
      "Answers the HOLDER of the bearer key — valid or not — with its state: " +
      "`active`, `awaiting_approval` (+ the approval page), `revoked` (+ when, " +
      "why, and when/where a replacing connection was created), `expired`, or " +
      "`unknown` for a secret this pod never issued. Looked up by the secret " +
      "only; reveals nothing about any key the caller does not hold.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "The presented key's state.",
        content: { "application/json": { schema: KeyHolderStateSchema } },
      },
      401: { $ref: "#/components/responses/Unauthorized" },
      403: {
        description: "A guest's key: refused, never described.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      500: {
        description: "Internal error",
        content: { "application/json": { schema: ErrorSchema } },
      },
    },
  });

  // Auth-skipped (`_middleware/auth-skip.ts`): the key under question
  // may not authenticate — that is the point. It reads the bearer itself.
  app.openapi(keyStateRoute, async (c) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) return authErrorResponse(c, "no_auth") as never;
    try {
      // This door skips hub auth, so it owns the guest refusal hub auth gives
      // every other route (guest-containment tripwire): a guest's key gets the
      // same 403 here, never a description.
      const status = await apiKeyService.getApiKeyStatus(token);
      if (
        "record" in status &&
        status.record &&
        (await isGuestPrincipal(status.record.userId, c.req.raw))
      )
        return c.json(GUEST_REFUSED_BODY, 403);
      // Pod-access floor, report mode (B1, access/pod-access.ts).
      if ("record" in status && status.record)
        await reportNoPodAccess(
          status.record.userId,
          c.req.raw,
          "hub:/auth/key-state"
        );
      // The status just read is handed on: a second lookup would repeat the
      // (legacy bcrypt) work for every unknown key.
      return c.json(await describeKeyForHolder(token, c.req.url, status), 200);
    } catch (err) {
      logger.error({ err }, "/auth/key-state lookup failed");
      return c.json(
        { error: "Could not read this key's state" },
        httpStatusForTrpcError(err)
      ) as never;
    }
  });
}
