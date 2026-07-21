/**
 * Hub Protocol REST — POST /federation/oidc-config
 *
 * Receiving end of a CP→pod push for per-pod OIDC federation. The control
 * plane mints an OIDC client for this pod (so the pod's Kratos can federate
 * sign-in through the CP as its OIDC provider) and pushes the credentials
 * here. The bash generator on the pod then reads them out of `pod_settings`
 * to render the Kratos `oidc` provider config.
 *
 * Auth: inherits the standard Hub-key Bearer middleware (see
 * `hub-protocol-rest.ts`) — the CP calls with `Authorization: Bearer <pod hub
 * key>`. Deliberately NOT gated on `hub-protocol.write`: the CP's provisioning
 * key is what authenticates the push, and adding a scope gate would risk
 * 403-ing a legitimate CP key whose scope set doesn't include write. This is an
 * operator-infrastructure receiver, not a user-data write.
 *
 * Storage: `pod_settings.settings.federationOidcClient` (JSONB on the existing
 * singleton row) — NO new table/migration. Single atomic UPDATE via `jsonb_set`
 * that replaces only the `federationOidcClient` key, preserving sibling
 * settings keys (same pattern as `catalog-sync-stamps.ts`).
 */

import { z } from "@hono/zod-openapi";
import {
  db,
  podSettings,
  drizzleSql,
  eq,
  type FederationOidcClient,
} from "@synap/database";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { logger, type HubHono } from "./_shared.js";

const FederationOidcConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  issuer: z.string().url(),
  redirectUri: z.string().url(),
});

export function registerFederationRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/federation/oidc-config",
    tags: ["System"],
    summary: "Receive a CP→pod OIDC federation client push",
    description:
      "Persists the control-plane-minted OIDC client (clientId/clientSecret/" +
      "issuer/redirectUri) into pod_settings.settings.federationOidcClient so " +
      "the pod's Kratos can federate sign-in through the CP. Idempotent — " +
      "overwrites the single federationOidcClient key on each push.",
    request: {
      body: FederationOidcConfigSchema,
    },
    responses: {
      200: {
        description: "Stored",
        schema: z.object({ ok: z.literal(true) }),
      },
      400: { description: "Invalid body", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/federation/oidc-config", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = FederationOidcConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }

    const client: FederationOidcClient = {
      clientId: parsed.data.clientId,
      clientSecret: parsed.data.clientSecret,
      issuer: parsed.data.issuer,
      redirectUri: parsed.data.redirectUri,
      updatedAt: new Date().toISOString(),
    };
    const clientObj = JSON.stringify(client);

    try {
      // Read-modify-write the singleton pod_settings row. `jsonb_set` sets only
      // the `federationOidcClient` key (creating it if missing), so sibling
      // settings keys (intelligenceDefaults, catalogSyncStamps, …) are never
      // clobbered.
      const [existing] = await db
        .select({ id: podSettings.id })
        .from(podSettings)
        .orderBy(podSettings.createdAt)
        .limit(1);

      if (existing) {
        await db
          .update(podSettings)
          .set({
            settings: drizzleSql`jsonb_set(
              coalesce(${podSettings.settings}, '{}'::jsonb),
              '{federationOidcClient}',
              ${clientObj}::jsonb,
              true
            )`,
            updatedAt: new Date(),
          })
          .where(eq(podSettings.id, existing.id));
      } else {
        await db
          .insert(podSettings)
          .values({ settings: { federationOidcClient: client } });
      }

      return c.json({ ok: true } as const);
    } catch (err) {
      logger.error({ err }, "POST /federation/oidc-config failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
