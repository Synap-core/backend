/**
 * Admin Source Configs REST Router
 *
 * Trusted-issuer assertion protected endpoint for provisioning a
 * `source_configs` row programmatically. Unlike the tRPC router, this one accepts inline
 * secrets — each `secrets[]` entry is encrypted with the server vault key
 * and replaced with a `vault://<uuid>/value` reference in the stored config.
 *
 * Use case: any Pod-approved issuer can provision a source config for an
 * already-linked, locally authorized Pod user. The Pod stores supplied secrets
 * and rewrites their configured fields to vault references.
 *
 * Routes:
 *   POST /api/admin/source-configs  — create a source_config with inline secrets
 *
 * Auth:
 *   Authorization: Bearer <short-lived issuer assertion>
 *   Verified against the Pod-local trusted-issuer registry. The issuer's
 *   opaque subject resolves through the Pod's local identity-link table.
 */

import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "@synap-core/core";
import {
  and,
  consumeFederatedAssertionReceipt,
  db,
  eq,
  inArray,
  TrustedIssuerService,
  TRUSTED_ISSUER_CAPABILITIES,
} from "@synap/database";
import {
  federatedIdentityLinks,
  secrets,
  sourceConfigs,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import { verifyTrustedIssuerJwt } from "../utils/jwks-client.js";
import { encryptServerSide, isServerVaultAvailable } from "@synap/database";
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

const MAX_ASSERTION_LIFETIME_SECONDS = 300;

const sourceConfigAssertionSchema = z.object({
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1).max(512),
  iss: z.string().url(),
  sub: z.string().min(1).max(512),
  type: z.literal("federated_assertion"),
  purpose: z.literal("source-config-write"),
});

function podAudience(): string | null {
  const value = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  return value || null;
}

async function canWriteSourceConfig(input: {
  userId: string;
  workspaceId?: string;
}): Promise<boolean> {
  const allowedRoles = ["owner", "admin", "editor"];
  if (input.workspaceId) {
    const membership = await db
      .select({
        role: workspaceMembers.role,
        archivedAt: workspaces.archivedAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, input.userId),
          eq(workspaceMembers.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    return !!(
      membership[0] &&
      !membership[0].archivedAt &&
      allowedRoles.includes(membership[0].role)
    );
  }

  // Pod-wide source configuration is an administrative operation. A user with
  // access only to an ordinary workspace cannot create it through an issuer.
  const podAdmin = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, input.userId),
        eq(workspaces.systemSlug, "pod-admin")
      )
    )
    .limit(1);
  return !!podAdmin[0] && ["owner", "admin"].includes(podAdmin[0].role);
}

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
  // 1. Verify a short-lived assertion from a Pod-approved issuer. The Pod
  // selects the issuer record and its capability before fetching JWKS; no
  // deployment-level provider URL is trusted implicitly.
  const auth = c.req.header("authorization");
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) {
    return c.json({ error: "Missing Bearer token" }, 401);
  }
  const audience = podAudience();
  if (!audience) return c.json({ error: "PUBLIC_URL is required" }, 500);
  const payload = await verifyTrustedIssuerJwt<Record<string, unknown>>(token, {
    audience,
    requiredScope: TRUSTED_ISSUER_CAPABILITIES.SOURCE_CONFIG_WRITE,
    consumeJti: false,
  });
  const claims = sourceConfigAssertionSchema.safeParse(payload);
  if (
    !claims.success ||
    claims.data.exp - claims.data.iat > MAX_ASSERTION_LIFETIME_SECONDS
  ) {
    return c.json({ error: "Invalid source-config assertion" }, 401);
  }
  const issuer = await new TrustedIssuerService().getByUrl(claims.data.iss);
  if (
    !issuer ||
    issuer.status !== "approved" ||
    !issuer.allowedScopes.includes(
      TRUSTED_ISSUER_CAPABILITIES.SOURCE_CONFIG_WRITE
    )
  ) {
    return c.json({ error: "Issuer is not approved" }, 403);
  }

  // 2. Resolve an opaque issuer subject to a Pod-local identity. The issuer
  // never chooses a local owner id in this request.
  const identityLink = await db.query.federatedIdentityLinks.findFirst({
    where: and(
      eq(federatedIdentityLinks.issuerId, issuer.id),
      eq(federatedIdentityLinks.issuerSubject, claims.data.sub)
    ),
    columns: { userId: true },
  });
  if (!identityLink) {
    return c.json(
      { error: "Federated identity is not linked on this Pod" },
      403
    );
  }

  // 3. Parse the requested Pod-local target before consuming the assertion.
  const bodyRaw = await c.req.json().catch(() => null);
  const parsed = createInputSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid body", details: parsed.error.format() },
      400
    );
  }
  const input = parsed.data;

  if (
    !(await canWriteSourceConfig({
      userId: identityLink.userId,
      workspaceId: input.workspaceId,
    }))
  ) {
    return c.json(
      { error: "Local user is not allowed to write this source config" },
      403
    );
  }

  const linkedUserId = identityLink.userId;

  // 4. Validate provider exists.
  const provider = sourceProviderRegistry.get(input.providerType);
  if (!provider) {
    return c.json(
      { error: `Unknown providerType: ${input.providerType}` },
      400
    );
  }

  // Reject unavailable local prerequisites before spending this single-use
  // assertion, so a caller can retry after the Pod operator fixes its vault.
  if (input.secrets?.length && !isServerVaultAvailable()) {
    return c.json(
      {
        error:
          "VAULT_SERVER_KEY is not configured on this pod — cannot encrypt inline secrets",
      },
      500
    );
  }

  // Make a valid, locally authorized mutation assertion durable-single-use
  // before it can create a secret or source config.
  try {
    const receipt = await consumeFederatedAssertionReceipt({
      issuerId: issuer.id,
      jti: claims.data.jti,
      expiresAt: new Date(claims.data.exp * 1_000),
    });
    if (receipt === "expired") {
      return c.json({ error: "Source-config assertion has expired" }, 401);
    }
    if (receipt === "replayed") {
      return c.json(
        { error: "Source-config assertion has already been used" },
        409
      );
    }
  } catch (error) {
    logger.error(
      { error, issuerId: issuer.id },
      "Could not record source-config assertion replay receipt"
    );
    return c.json(
      { error: "Source-config replay protection is unavailable" },
      503
    );
  }

  // 5. Create secrets (if any) and rewrite config with vault:// refs.
  const configOut = structuredClone(input.config) as Record<string, unknown>;
  const createdSecretIds: string[] = [];

  if (input.secrets?.length) {
    for (const entry of input.secrets) {
      const blob = encryptServerSide(entry.value);
      // Direct insert (not upsert) — we need one secret row per inline entry
      // and we retag serviceId to 'source:<configId>' after the config row
      // is created (see step 6 below).
      const [secret] = await db
        .insert(secrets)
        .values({
          userId: linkedUserId,
          serviceId: "source:admin-provisioned",
          name: `source-config "${input.name}" — ${entry.field}`,
          type: "api_key",
          category: "feed-sources",
          description: `Inline secret provisioned by a trusted issuer for source "${input.name}" field "${entry.field}"`,
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

  // 6. Insert the source_config row.
  const [row] = await db
    .insert(sourceConfigs)
    .values({
      userId: linkedUserId,
      workspaceId: input.workspaceId ?? null,
      providerType: input.providerType,
      name: input.name,
      description: input.description,
      config: configOut,
      enabled: true,
    })
    .returning();

  // 7. Re-tag the secrets with the real config id so the delete-cascade
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
  logger.info(
    {
      configId: row.id,
      providerType: row.providerType,
      linkedUserId,
      secretCount: createdSecretIds.length,
    },
    "Source config provisioned through generic issuer federation"
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
