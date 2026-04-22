/**
 * Admin Source Configs REST Router
 *
 * CP-signed ES256 JWT protected endpoint for provisioning a `source_configs`
 * row programmatically. Unlike the tRPC router, this one accepts inline
 * secrets — each `secrets[]` entry is encrypted with the server vault key
 * and replaced with a `vault://<uuid>/value` reference in the stored config.
 *
 * Use case: CP wants to provision a CPRelay source config on a pod it just
 * created, using a fresh relay key. CP calls this endpoint with
 *   { providerType: 'cp-relay', name: 'CP Relay (prod)',
 *     config: { relayUrl: '…', upstreamType: 'rss-direct', upstreamConfig: {…} },
 *     secrets: [{ field: 'relayKey', value: '<generated-key>' }] }
 * and the pod stores the secret + rewrites config.relayKey to a vault://
 * reference.
 *
 * Routes:
 *   POST /api/admin/source-configs  — create a source_config with inline secrets
 *
 * Auth:
 *   Authorization: Bearer <ES256 JWT signed by Control Plane>
 *   Verified via verifyCpJwt — same JWKS flow used by provision/*.
 */

import { Hono } from "hono";
import { z } from "zod";
import { createLogger, config } from "@synap-core/core";
import { db, drizzleSql, inArray } from "@synap/database";
import { sourceConfigs, secrets } from "@synap/database";
import { verifyCpJwt } from "../utils/jwks-client.js";
import {
  encryptServerSide,
  isServerVaultAvailable,
} from "../utils/server-vault.js";
import { sourceProviderRegistry } from "@synap/feed-service";

const logger = createLogger({ module: "admin-source-configs" });

export const adminSourceConfigsRouter = new Hono();

// ── Input schema ─────────────────────────────────────────────────────────────

const inlineSecretSchema = z.object({
  /** Dotted JSON path into the config where the vault reference should land. */
  field: z.string().min(1),
  value: z.string().min(1),
});

const createInputSchema = z.object({
  providerType: z.string().min(1),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  config: z.record(z.string(), z.unknown()),
  secrets: z.array(inlineSecretSchema).optional(),
  /** Optional: tie the config to a specific workspace. Null/omitted = pod-wide. */
  workspaceId: z.string().uuid().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Write `value` into `root` at the dotted path. Arrays and objects are
 * created as needed; numeric segments land as array indices.
 */
function setDeep(
  root: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split(".");
  let node: unknown = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (Array.isArray(node)) {
      const idx = Number.parseInt(key, 10);
      if (node[idx] == null) node[idx] = {};
      node = node[idx];
    } else if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (obj[key] == null || typeof obj[key] !== "object") {
        obj[key] = {};
      }
      node = obj[key];
    } else {
      return;
    }
  }
  const tail = parts[parts.length - 1];
  if (Array.isArray(node)) {
    node[Number.parseInt(tail, 10)] = value;
  } else if (node && typeof node === "object") {
    (node as Record<string, unknown>)[tail] = value;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

adminSourceConfigsRouter.post("/", async (c) => {
  // 1. Verify the CP JWT.
  const auth = c.req.header("authorization");
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    return c.json({ error: "Missing Bearer token" }, 401);
  }

  const payload = await verifyCpJwt<{
    type?: string;
    sub?: string;
    scope?: string;
    /**
     * The user id to own the created source_config + secrets.
     * CP supplies this — typically the pod's admin user.
     */
    ownerUserId?: string;
  }>(token, config.server.controlPlaneUrl);
  if (!payload) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const ownerUserId = payload.ownerUserId || payload.sub;
  if (!ownerUserId) {
    return c.json({ error: "Token missing ownerUserId / sub claim" }, 400);
  }

  // 2. Parse body.
  const bodyRaw = await c.req.json().catch(() => null);
  const parsed = createInputSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.format() },
      400
    );
  }
  const input = parsed.data;

  // 3. Validate provider exists.
  const provider = sourceProviderRegistry.get(input.providerType);
  if (!provider) {
    return c.json(
      { error: `Unknown providerType: ${input.providerType}` },
      400
    );
  }

  // 4. Create secrets (if any) and rewrite config with vault:// refs.
  const configOut = structuredClone(input.config) as Record<string, unknown>;
  const createdSecretIds: string[] = [];

  if (input.secrets?.length) {
    if (!isServerVaultAvailable()) {
      return c.json(
        {
          error:
            "VAULT_SERVER_KEY is not configured on this pod — cannot encrypt inline secrets",
        },
        500
      );
    }

    for (const entry of input.secrets) {
      const blob = encryptServerSide(entry.value);
      // Direct insert (not upsert) — we need one secret row per inline entry
      // and we retag serviceId to 'source:<configId>' after the config row
      // is created (see step 6 below).
      const [secret] = await db
        .insert(secrets)
        .values({
          userId: ownerUserId,
          serviceId: "source:admin-provisioned",
          name: `source-config "${input.name}" — ${entry.field}`,
          type: "api_key",
          category: "feed-sources",
          description: `Inline secret provisioned by CP for source "${input.name}" field "${entry.field}"`,
          encryptedData: blob.encryptedData,
          iv: blob.iv,
          authTag: blob.authTag,
          encryptionMode: "server",
          encryptionVersion: 1,
        })
        .returning();
      createdSecretIds.push(secret.id);
      setDeep(configOut, entry.field, `vault://${secret.id}/value`);
    }
  }

  // 5. Insert the source_config row.
  const [row] = await db
    .insert(sourceConfigs)
    .values({
      userId: ownerUserId,
      workspaceId: input.workspaceId ?? null,
      providerType: input.providerType,
      name: input.name,
      description: input.description,
      config: configOut,
      enabled: true,
    })
    .returning();

  // 6. Re-tag the secrets with the real config id so the delete-cascade
  //    cleanup path (secrets WHERE serviceId = "source:<id>") finds them.
  if (createdSecretIds.length > 0) {
    try {
      await db
        .update(secrets)
        .set({ serviceId: `source:${row.id}` })
        .where(inArray(secrets.id, createdSecretIds));
    } catch (err) {
      logger.warn(
        { err, configId: row.id, secretIds: createdSecretIds },
        "Failed to retag provisioned secrets — cascade delete will need manual purge"
      );
    }
  }
  // Silence tree-shakers if drizzleSql isn't used in any future code path.
  void drizzleSql;

  logger.info(
    {
      configId: row.id,
      providerType: row.providerType,
      ownerUserId,
      secretCount: createdSecretIds.length,
    },
    "Source config provisioned by CP"
  );

  return c.json(
    {
      id: row.id,
      providerType: row.providerType,
      name: row.name,
    },
    201
  );
});
