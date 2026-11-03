/**
 * Hub Protocol REST — POST /catalog/refresh
 * =========================================
 *
 * Refreshes this pod's copy of the OFFICIAL catalog (`cp_catalog_cache`) now,
 * with the same sync the 10-min schedule runs (`refreshOfficialCatalogNow`,
 * `@synap/jobs`). The update verdicts (`GET /package-updates`, the template
 * health on `GET /workspaces` and `GET /installed`) read that cache, so
 * without this a template published a minute ago reads "up to date" for up
 * to 10 minutes. The CLI calls it before `market update` / `market installed`.
 *
 * Bounded: concurrent calls share one run, and a call within 20 s of a
 * finished run gets that run's outcome (`reused: true`), so no caller can
 * hammer the Control Plane.
 *
 * Who may call: pod admins, like `GET /package-updates` (whose verdict this
 * refreshes) and pod admin's "Sync now" (`marketplace.sources.syncNow`,
 * `podAdminProcedure`). The run converges every installed capability whose
 * template changed (the schedule's after-sync step): an effect on the whole
 * pod, not on one person's rows.
 *
 * A refresh that could not read the catalog is an error with its reason
 * (409 switched off, 502 unreachable or refused), never `ok`: an empty result
 * and a failed read are different facts.
 */

import { z as zOpenapi } from "@hono/zod-openapi";
import {
  CATALOG_KINDS,
  CatalogRefreshError,
  refreshOfficialCatalogNow,
} from "@synap/jobs";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  errCode,
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
} from "./_shared.js";
import { assertPodAdmin } from "../../../trpc.js";

const KindStatusSchema = zOpenapi.enum([
  "ok",
  "partial",
  "empty",
  "unreachable",
  "misconfigured",
]);

const RefreshResponseSchema = zOpenapi
  .object({
    ok: zOpenapi.literal(true),
    /** ISO time the sync run finished. */
    refreshedAt: zOpenapi.string(),
    /** True when this call joined a running refresh or got one under the 20 s floor. */
    reused: zOpenapi.boolean(),
    /** What each catalog kind did in that run. */
    kinds: zOpenapi.object(
      Object.fromEntries(CATALOG_KINDS.map((k) => [k, KindStatusSchema])) as {
        [K in (typeof CATALOG_KINDS)[number]]: typeof KindStatusSchema;
      }
    ),
  })
  .openapi("CatalogRefreshResponse");

const RefreshErrorSchema = zOpenapi
  .object({
    error: zOpenapi.string(),
    reason: zOpenapi.enum(["switched_off", "unreachable", "rejected"]),
  })
  .openapi("CatalogRefreshError");

/** HTTP status of a refresh that could not read the catalog. */
export function refreshFailureStatus(
  reason: CatalogRefreshError["reason"]
): 409 | 502 {
  return reason === "switched_off" ? 409 : 502;
}

export function registerCatalogRefreshRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/catalog/refresh",
    tags: ["Packages"],
    summary: "Refresh this pod's copy of the official catalog now",
    description:
      "Runs the official catalog sync the pod otherwise runs every 10 " +
      "minutes, so the update verdicts (`GET /package-updates`, template " +
      "health) see a package published a moment ago. Concurrent calls share " +
      "one run; a call within 20 s of a finished run gets that run's outcome " +
      "(`reused: true`). A refresh that could not read the catalog answers " +
      "409 (the source is switched off) or 502 (unreachable or refused), " +
      "never `ok`. Pod admins only. Requires hub-protocol.read scope.",
    responses: {
      200: { description: "Refreshed", schema: RefreshResponseSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      409: {
        description: "The official catalog is switched off on this pod",
        schema: RefreshErrorSchema,
      },
      502: {
        description:
          "The catalog could not be read; the pod keeps its last copy",
        schema: RefreshErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/catalog/refresh", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    try {
      await assertPodAdmin(c.get("userId") as string);
    } catch (err) {
      if (errCode(err) === "FORBIDDEN") {
        return c.json(
          {
            error:
              "Only a pod admin can refresh the catalog; it refreshes itself every 10 minutes.",
          },
          403
        );
      }
      logger.error({ err }, "catalog refresh: pod admin check failed");
      return c.json(
        { error: "Could not check your access." },
        httpStatusForTrpcError(err)
      );
    }
    try {
      const run = await refreshOfficialCatalogNow();
      return c.json({ ok: true as const, ...run }, 200);
    } catch (err) {
      if (err instanceof CatalogRefreshError) {
        return c.json(
          { error: err.message, reason: err.reason },
          refreshFailureStatus(err.reason)
        );
      }
      logger.error({ err }, "catalog refresh failed");
      return c.json(
        {
          error: `The catalog refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        httpStatusForTrpcError(err)
      );
    }
  });
}
