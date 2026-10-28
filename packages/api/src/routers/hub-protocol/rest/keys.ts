/**
 * Hub Protocol REST — keys
 *
 *  - `POST /keys/rotate-cli`: self-service rotation for CLI and agent
 *    callers: revoke the calling key and re-issue it with the latest
 *    INTEGRATION_HUB_SCOPES.cli scope set.
 *  - KEY REQUESTS (keys plan Decision 4, `services/key-requests.ts`): the CLI
 *    asks for a key its person approves on pod-admin, then collects it once.
 *    `GET /keys/templates`, `POST /keys/requests`, `POST /keys/requests/token`
 *    (in the idempotency skip list: it returns a one-shot key),
 *    `GET /keys/requested`, `DELETE /keys/requested/:keyId`. The caller never
 *    mints: a request is a question to its person.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { db, eq, GrantRepository } from "@synap/database";
import { apiKeys } from "@synap/database/schema";
import type { ApiKeyScope } from "@synap/database";
import { apiKeyService } from "../../../services/api-keys.js";
import { INTEGRATION_HUB_SCOPES } from "../../../services/hub-integration-registration.js";
import {
  collectKeyRequest,
  createKeyRequest,
  listKeyTemplates,
  listRequestedKeys,
  revokeRequestedKey,
  type KeyRequestTokenError,
} from "../../../services/key-requests.js";
import { toPodAdminOrigin } from "../../../utils/pod-admin-origin.js";
import {
  ErrorSchema,
  bearerSecurity,
  trpcErrorResponses,
  uuidParam,
} from "./_codecs/_openapi.js";
import {
  hasScope,
  logger,
  type HubHono,
  httpStatusForTrpcError,
} from "./_shared.js";

/** Why this key may not self-rotate to the CLI scope set, or null if it may. */
export function rotateCliRefusal(key: {
  keyType: string;
  scope: string[];
  parentKeyId: string | null;
}): string | null {
  if (key.parentKeyId)
    return "A sub-token cannot be rotated here; its parent key owns its lifetime.";
  if (key.scope.includes("probe"))
    return "A probe key cannot be rotated to the CLI scope set.";
  if (key.keyType !== "hub_inbound")
    return "Only an agent or CLI key can be rotated here.";
  if (
    !key.scope.includes("hub-protocol.read") ||
    !key.scope.includes("hub-protocol.write")
  )
    return "This key is narrower than the CLI scope set; rotating it would widen it.";
  return null;
}

/** Days left on an expiry (fractional), or undefined for a key that never expires. */
function remainingDays(expiresAt: Date | null): number | undefined {
  if (!expiresAt) return undefined;
  return Math.max((expiresAt.getTime() - Date.now()) / 86_400_000, 1 / 1440);
}

export function registerKeysRoutes(app: HubHono): void {
  // ── POST /keys/rotate-cli ─────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/keys/rotate-cli",
      tags: ["Keys"],
      summary: "Rotate the calling key to the latest CLI scope set",
      description:
        "Revokes the current key and issues a new one with the full " +
        "INTEGRATION_HUB_SCOPES.cli scope set, keeping its expiry. Only an agent/CLI " +
        "key that already holds hub-protocol.read and hub-protocol.write qualifies; " +
        "sub-tokens and probe keys are refused.",
      security: bearerSecurity,
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "New key issued",
          content: {
            "application/json": {
              schema: z
                .object({
                  apiKey: z.string(),
                  keyId: z.string(),
                  scopes: z.array(z.string()),
                })
                .openapi("RotateCliKeyResult"),
            },
          },
        },
        400: {
          description: "Bad request",
          content: { "application/json": { schema: ErrorSchema } },
        },
        403: {
          description: "This key cannot be rotated to the CLI scope set",
          content: { "application/json": { schema: ErrorSchema } },
        },
        401: {
          description:
            "Unauthorized — no API key auth (session-token callers not supported)",
          content: { "application/json": { schema: ErrorSchema } },
        },
        500: {
          description: "Internal error",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const keyId = c.get("apiKeyId");
      const userId = c.get("userId") as string;

      if (!keyId) {
        return c.json(
          { error: "Key rotation requires API key auth (Bearer token)" },
          401
        );
      }

      // Load the full key record so we can forward the calling key's identity
      // to the replacement key.
      const keyRecord = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, keyId),
      });

      if (!keyRecord) {
        return c.json({ error: "Calling key not found" }, 400);
      }

      // Self-rotation may refresh the CLI scope set, never WIDEN a key. Only an
      // agent/CLI key (hub_inbound) that already holds read+write qualifies;
      // a narrower key (a read-only service key, a sub-token bounded by its
      // parent, a probe key) would come out with more authority than it has.
      const refusal = rotateCliRefusal(keyRecord);
      if (refusal) return c.json({ error: refusal }, 403);

      try {
        // SECURITY: this is a ROTATION, so the new key must be the SAME
        // credential with fresh material — only the SCOPE SET is deliberately
        // refreshed to INTEGRATION_HUB_SCOPES.cli. Everything that defines the
        // key's identity, confinement and governance is carried over verbatim;
        // letting any of it fall back to a schema default silently escalates the
        // rotated key (keyType → a 'service' key stops being confined by
        // `resolveConfinedWorkspace`; workspaceId → the confinement binding
        // itself; linkedUserId → the agent's writes stop routing through the
        // governance membrane as proposals; instanceId → per-instance rotation
        // scoping). Mirrors `ApiKeyRepository.rotate()`.
        const { key: newKey, keyId: newKeyId } =
          await apiKeyService.generateApiKey(
            keyRecord.userId,
            keyRecord.keyName,
            INTEGRATION_HUB_SCOPES.cli as ApiKeyScope[],
            keyRecord.hubId ?? undefined,
            // Keep the key's lifetime: rotation is new material, not a new
            // term. A `null` expiry passed as undefined used to make a 90-day
            // agent key permanent.
            remainingDays(keyRecord.expiresAt),
            // parentKeyId is deliberately NOT carried: passing it re-runs
            // sub-token validation, which enforces a scope SUBSET of the parent
            // — and this door intentionally RE-SCOPES to the CLI set, which need
            // not be a subset. KNOWN RESIDUAL GAP: if a CLI key were ever also a
            // sub-token, the rotated key would escape its parent's cascade
            // revoke. No current mint path produces such a key, but this is not
            // structurally enforced. Revisit when the `connections` SSOT lands.
            undefined,
            {
              keyType: keyRecord.keyType,
              workspaceId: keyRecord.workspaceId,
              linkedUserId: keyRecord.linkedUserId,
              instanceId: keyRecord.instanceId,
              description: keyRecord.description,
            }
          );

        // The grant is part of the credential: a rotated key that lost it
        // would resolve as ungranted (everything its scopes allow).
        try {
          await new GrantRepository(db).carryOver({
            fromKeyId: keyId,
            toKeyId: newKeyId,
            by: userId,
          });
        } catch (err) {
          await apiKeyService.revokeApiKey(
            newKeyId,
            userId,
            "Rotation could not carry the key's grant"
          );
          throw err;
        }

        await apiKeyService.revokeApiKey(
          keyId,
          userId,
          "Rotated to updated CLI scopes"
        );

        logger.info(
          { oldKeyId: keyId, newKeyId, userId },
          "CLI key rotated via POST /keys/rotate-cli"
        );

        return c.json(
          {
            apiKey: newKey,
            keyId: newKeyId,
            scopes: INTEGRATION_HUB_SCOPES.cli,
          },
          200
        );
      } catch (err) {
        logger.error({ err, keyId, userId }, "POST /keys/rotate-cli failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  registerKeyRequestRoutes(app);
}

/** Human words for each poll error (`error_description`, RFC 8628 §3.5). */
const KEY_REQUEST_ERROR_DESCRIPTIONS = {
  authorization_pending: "Waiting for you to approve the key on the page.",
  slow_down: "Polling too fast — wait the interval before asking again.",
  access_denied: "The request was denied.",
  expired_token: "This request expired or was already used. Start again.",
  invalid_grant: "Unknown request code.",
} as const satisfies Record<KeyRequestTokenError, string>;

const KeyTemplateSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    stored: z.boolean(),
    uses: z.array(z.string()),
    permissions: z.array(z.string()),
    workspaceIds: z.array(z.string()).nullable(),
    projectIds: z.array(z.string()).nullable(),
    entityIds: z.array(z.string()).nullable(),
    expiresInDays: z.number().int().nullable().optional(),
  })
  .openapi("KeyTemplate");

const RequestedKeySchema = z
  .object({
    keyId: z.string(),
    name: z.string(),
    keyPrefix: z.string(),
    templateId: z.string(),
    scopes: z.array(z.string()),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .openapi("RequestedKey");

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The principal asking: the computer's agent user, else the person. */
function requesterOf(agentUserId: unknown, userId: unknown): string {
  return ((agentUserId as string | undefined) || userId) as string;
}

function registerKeyRequestRoutes(app: HubHono): void {
  // ── GET /keys/templates ───────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/keys/templates",
      tags: ["Keys"],
      summary: "The templates a key can be requested from",
      description:
        "The built-in key templates (Dev loop poster, Website or pod app, " +
        "Read-only, Full access), then the person's own roles that say where " +
        "a key is used. `synap keys templates` lists these.",
      security: bearerSecurity,
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Templates",
          content: {
            "application/json": {
              schema: z.object({ templates: z.array(KeyTemplateSchema) }),
            },
          },
        },
        403: {
          description: "Forbidden — missing scope",
          content: { "application/json": { schema: ErrorSchema } },
        },
        401: {
          description: "Unauthorized",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      if (!hasScope(c.get("scopes"), "hub-protocol.read"))
        return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
      try {
        const templates = await listKeyTemplates(c.get("userId") as string);
        return c.json({ templates }, 200);
      } catch (err) {
        logger.error({ err }, "GET /keys/templates failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── POST /keys/requests ───────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/keys/requests",
      tags: ["Keys"],
      summary: "Ask the person for a key made from a template",
      description:
        "Files a key request the person approves on the pod-admin page " +
        "`review_url` (they may narrow it, never widen it past the template). " +
        "It waits 24 hours; asking the same again returns the request already " +
        "waiting (same id and link, a new `request_code`). " +
        "Then poll `POST /keys/requests/token` with `request_code` to collect " +
        "the key once. The caller never mints a key itself.",
      security: bearerSecurity,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({
                  template: z.string().min(1).max(120),
                  name: z.string().trim().min(1).max(100).optional(),
                  /** Days (1-36500), or null = never; omitted = the template's. */
                  expiresInDays: z
                    .number()
                    .int()
                    .min(1)
                    .max(36_500)
                    .nullable()
                    .optional(),
                  workspaceId: uuidParam.optional(),
                  /** Narrow the key to one project (no Activity there). */
                  projectId: uuidParam.optional(),
                })
                .openapi("KeyRequestInput"),
            },
          },
        },
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Request filed",
          content: {
            "application/json": {
              schema: z
                .object({
                  request_code: z.string(),
                  request_id: z.string(),
                  review_url: z.string(),
                  expires_in: z.number(),
                  interval: z.number(),
                })
                .openapi("KeyRequestResult"),
            },
          },
        },
        403: {
          description: "Forbidden — missing scope",
          content: { "application/json": { schema: ErrorSchema } },
        },
        401: {
          description: "Unauthorized — a key request is made with a key",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const keyId = c.get("apiKeyId");
      if (!keyId)
        return c.json(
          { error: "A key request is made with an API key (Bearer token)." },
          401
        );
      if (!hasScope(c.get("scopes"), "hub-protocol.write"))
        return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
      const body = c.req.valid("json");
      const origin = process.env.PUBLIC_URL || new URL(c.req.url).origin;
      try {
        const res = await createKeyRequest({
          requesterUserId: requesterOf(c.get("agentUserId"), c.get("userId")),
          requesterKeyId: keyId,
          personUserId: c.get("userId") as string,
          templateId: body.template,
          name: body.name,
          expiresInDays: body.expiresInDays,
          workspaceId: body.workspaceId,
          projectId: body.projectId,
          podAdminOrigin: toPodAdminOrigin(origin),
        });
        c.header("Cache-Control", "no-store");
        return c.json(res, 200);
      } catch (err) {
        logger.error({ err }, "POST /keys/requests failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── POST /keys/requests/token ─────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/keys/requests/token",
      tags: ["Keys"],
      summary: "Collect an approved key, once",
      description:
        "Poll with the `request_code` of `POST /keys/requests`, every " +
        "`interval` seconds. Answers 400 `authorization_pending` until the " +
        "person decides; then 200 with the key, exactly once. Only the caller " +
        "that filed the request may collect it.",
      security: bearerSecurity,
      request: {
        body: {
          content: {
            "application/json": {
              schema: z
                .object({ request_code: z.string().min(16).max(128) })
                .openapi("KeyRequestTokenInput"),
            },
          },
        },
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "The key — shown once",
          content: {
            "application/json": {
              schema: z
                .object({
                  apiKey: z.string(),
                  keyId: z.string(),
                  keyPrefix: z.string(),
                  name: z.string(),
                  scopes: z.array(z.string()),
                  expiresAt: z.string().nullable(),
                })
                .openapi("KeyRequestTokenResult"),
            },
          },
        },
        400: {
          description:
            "Not collected: authorization_pending | slow_down | access_denied | expired_token | invalid_grant",
          content: {
            "application/json": {
              schema: z
                .object({
                  error: z.string(),
                  error_description: z.string(),
                  interval: z.number().optional(),
                })
                .openapi("KeyRequestTokenError"),
            },
          },
        },
        401: {
          description: "Unauthorized",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      if (!c.get("apiKeyId"))
        return c.json(
          { error: "Collect a key with the API key that asked for it." },
          401
        );
      const body = c.req.valid("json");
      c.header("Cache-Control", "no-store");
      try {
        const result = await collectKeyRequest({
          requestCode: body.request_code,
          requesterUserId: requesterOf(c.get("agentUserId"), c.get("userId")),
        });
        if (result.ok) return c.json(result.body, 200);
        return c.json(
          {
            error: result.error,
            error_description: KEY_REQUEST_ERROR_DESCRIPTIONS[result.error],
            ...(result.interval ? { interval: result.interval } : {}),
          },
          400
        );
      } catch (err) {
        logger.error({ err }, "POST /keys/requests/token failed");
        return c.json(
          { error: "The key could not be made. Run the command again." },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── GET /keys/requested ───────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/keys/requested",
      tags: ["Keys"],
      summary: "The keys this caller requested",
      description:
        "Only keys minted from this caller's own key requests — never the " +
        "person's other keys (`synap open keys` shows those).",
      security: bearerSecurity,
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Requested keys",
          content: {
            "application/json": {
              schema: z.object({ keys: z.array(RequestedKeySchema) }),
            },
          },
        },
        403: {
          description: "Forbidden — missing scope",
          content: { "application/json": { schema: ErrorSchema } },
        },
        401: {
          description: "Unauthorized",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      if (!hasScope(c.get("scopes"), "hub-protocol.read"))
        return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
      try {
        const keys = await listRequestedKeys(
          requesterOf(c.get("agentUserId"), c.get("userId"))
        );
        return c.json(
          {
            keys: keys.map((k) => ({
              ...k,
              createdAt: k.createdAt.toISOString(),
              expiresAt: iso(k.expiresAt),
              lastUsedAt: iso(k.lastUsedAt),
              revokedAt: iso(k.revokedAt),
            })),
          },
          200
        );
      } catch (err) {
        logger.error({ err }, "GET /keys/requested failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── DELETE /keys/requested/:keyId ─────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "delete",
      path: "/keys/requested/{keyId}",
      tags: ["Keys"],
      summary: "Revoke a key this caller requested",
      description:
        "Revokes a key minted from this caller's own key request. Any other " +
        "key is 404: a computer never revokes the person's other keys.",
      security: bearerSecurity,
      request: { params: z.object({ keyId: uuidParam }) },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Revoked",
          content: {
            "application/json": {
              schema: z.object({ revoked: z.boolean() }),
            },
          },
        },
        403: {
          description: "Forbidden — missing scope",
          content: { "application/json": { schema: ErrorSchema } },
        },
        401: {
          description: "Unauthorized",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      if (!hasScope(c.get("scopes"), "hub-protocol.write"))
        return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
      const { keyId } = c.req.valid("param");
      try {
        const res = await revokeRequestedKey({
          requesterUserId: requesterOf(c.get("agentUserId"), c.get("userId")),
          keyId,
          by: requesterOf(c.get("agentUserId"), c.get("userId")),
        });
        return c.json(res, 200);
      } catch (err) {
        logger.error({ err }, "DELETE /keys/requested/:keyId failed");
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );
}
