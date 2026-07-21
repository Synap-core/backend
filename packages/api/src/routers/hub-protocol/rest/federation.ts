/**
 * Hub Protocol REST — POST /federation/oidc-config
 *
 * Receiving end of a CP→pod push for per-pod OIDC federation. The control plane
 * mints an OIDC client for this pod (so the pod's Kratos can federate sign-in
 * through the CP as its OIDC provider) and pushes the credentials here. The bash
 * generator on the pod then reads them out of `pod_settings` to render the
 * Kratos `oidc` provider config.
 *
 * Auth: a **CP-signed assertion**, verified with `verifyIssuerJwt` against the
 * trusted issuer this pod already pins (the same trust `/api/federation/exchange`
 * uses). NOT the Hub key — a pod holds no durable secret it can share with the
 * CP, and the pod's stored hub key has drifted from the CP's copy; the CP's
 * ES256 signing key is the credential the pod verifiably trusts. This route is
 * therefore listed in `skipAuthPaths` (it does its own verification) — mirroring
 * `setup.ts`. The OIDC client fields live INSIDE the signed assertion, so they
 * cannot be tampered independently of the signature.
 *
 * Storage: `pod_settings.settings.federationOidcClient` (JSONB on the existing
 * singleton row) — NO new table/migration. Single atomic UPDATE via `jsonb_set`
 * that replaces only the `federationOidcClient` key, preserving sibling settings
 * (same pattern as `catalog-sync-stamps.ts`).
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
import { verifyIssuerJwt } from "../../../utils/jwks-client.js";

const RequestSchema = z.object({ assertion: z.string().min(1) });

/** The signed CP→pod OIDC-config payload (carried inside the assertion). */
interface OidcConfigAssertion {
  type: string;
  podOrigin: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  redirectUri: string;
}

function normalizeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return u;
  }
}

export function registerFederationRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/federation/oidc-config",
    tags: ["System"],
    summary: "Receive a CP→pod OIDC federation client push",
    description:
      "Persists the control-plane-minted OIDC client (inside a CP-signed " +
      "assertion) into pod_settings.settings.federationOidcClient so the pod's " +
      "Kratos can federate sign-in through the CP. Authenticated by the CP's " +
      "issuer signature (verifyIssuerJwt), not the Hub key. Idempotent.",
    request: {
      body: RequestSchema,
    },
    responses: {
      200: {
        description: "Stored",
        schema: z.object({ ok: z.literal(true) }),
      },
      400: { description: "Invalid body", schema: ErrorSchema },
      401: { description: "Assertion did not verify", schema: ErrorSchema },
      403: {
        description: "Assertion is for a different pod",
        schema: ErrorSchema,
      },
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
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }

    // Authenticate the push by verifying the CP's signature (the trusted issuer
    // this pod pins), NOT a hub key.
    const payload = await verifyIssuerJwt<OidcConfigAssertion>(
      parsed.data.assertion
    );
    if (!payload || payload.type !== "oidc-config-push") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    // Bind the assertion to THIS pod: a CP assertion minted for another pod must
    // never configure this one.
    const myOrigin = process.env.PUBLIC_URL
      ? normalizeOrigin(process.env.PUBLIC_URL)
      : null;
    if (myOrigin && normalizeOrigin(payload.podOrigin) !== myOrigin) {
      logger.warn(
        { podOrigin: payload.podOrigin, myOrigin },
        "OIDC config push: assertion pod mismatch"
      );
      return c.json({ error: "Assertion is for a different pod" }, 403);
    }
    if (
      !payload.clientId ||
      !payload.clientSecret ||
      !payload.issuer ||
      !payload.redirectUri
    ) {
      return c.json({ error: "Assertion missing OIDC client fields" }, 400);
    }

    const client: FederationOidcClient = {
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      issuer: payload.issuer,
      redirectUri: payload.redirectUri,
      updatedAt: new Date().toISOString(),
    };
    const clientObj = JSON.stringify(client);

    try {
      // Read-modify-write the singleton pod_settings row. `jsonb_set` sets only
      // the `federationOidcClient` key (creating it if missing), so sibling
      // settings keys (intelligenceDefaults, catalogSyncStamps, …) are untouched.
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

      logger.info(
        { clientId: client.clientId },
        "Stored CP-pushed OIDC federation client"
      );
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
