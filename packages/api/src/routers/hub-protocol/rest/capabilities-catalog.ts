/**
 * Hub Protocol REST — GET /capabilities/catalog
 *
 * The pack-grouped, status-computed capability CATALOG — the keystone of the
 * capability UX consolidation (CAPABILITIES-NORTH-STAR.md §8 Phase 1). Where
 * `GET /capabilities` returns the FLAT verb × grant matrix (every tool/skill its
 * own, duplicated, entry), this door returns ONE `CapabilityCard` per PACK:
 *   - one card per installed capability CONTAINER (member tools → connection,
 *     member skills → verbs), plus
 *   - one card per AVAILABLE template not yet installed.
 *
 * Each card carries a computed `status` (the §3 state machine) and exactly one
 * `nextAction`, so every surface (CLI / browser / Raycast) renders the same
 * status-driven view. Thin door: scope-gate + trusted acting identity, then
 * delegate to `buildCapabilityCatalog`. Read-only (hub-protocol.read).
 *
 * Routes:
 *   GET /capabilities/catalog?workspaceId=<uuid> — { capabilities: CapabilityCard[] }
 */

import { z } from "@hono/zod-openapi";

import { buildCapabilityCatalog } from "../../../services/capabilities/capability-catalog.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── OpenAPI response schema (mirrors the CapabilityCard contract) ─────────────

const ConnectionSchema = z.object({
  required: z.boolean(),
  kind: z.enum(["provider", "vault"]).nullable(),
  provider: z.string().optional(),
  state: z.enum(["connected", "missing", "expired"]),
  account: z.string().optional(),
});

const VerbSchema = z.object({
  verbId: z.string(),
  label: z.string(),
  type: z.enum(["read", "write"]),
  enabled: z.boolean(),
  governance: z.enum(["auto", "propose"]),
  runnable: z.boolean(),
});

const CapabilityCardSchema = z.object({
  id: z.string().nullable(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  source: z.enum(["installed", "available"]),
  status: z.enum([
    "available",
    "needs_connection",
    "connected",
    "draft",
    "ready",
    "partial",
  ]),
  connection: ConnectionSchema.optional(),
  verbs: z.array(VerbSchema),
  nextAction: z.object({
    kind: z.enum(["add", "connect", "enable", "run", "none"]),
    hint: z.string(),
  }),
});

const CatalogResponseSchema = z.object({
  capabilities: z.array(CapabilityCardSchema),
});

// ── Register function ──────────────────────────────────────────────────────

export function registerCapabilitiesCatalogRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/capabilities/catalog",
    tags: ["Capabilities"],
    summary:
      "Pack-grouped, status-computed capability catalog (one row per pack)",
    description:
      "Returns ONE `CapabilityCard` per capability PACK: each installed container " +
      "(member tools folded into `connection`, member skills into `verbs`) plus " +
      "each available template not yet installed. Every card carries a computed " +
      "`status` (available / needs_connection / connected / draft / ready / " +
      "partial) and exactly one `nextAction`. De-duped by pack identity (the " +
      "container/template name) so duplicate bare tools/skills collapse under " +
      "their pack. Requires hub-protocol.read scope and a `workspaceId` query param.",
    request: {
      query: z.object({ workspaceId: z.string().uuid() }),
    },
    responses: {
      200: {
        description: "Capability catalog (pack cards)",
        schema: CatalogResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── GET /capabilities/catalog ──────────────────────────────────────────────
  // Static route — declared with the other static `/capabilities/*` doors,
  // BEFORE any dynamic `/capabilities/:id` (none today), per the Hono rule.
  app.get("/capabilities/catalog", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const workspaceId = c.req.query("workspaceId");
    const wsCheck = z.string().uuid().safeParse(workspaceId);
    if (!wsCheck.success) {
      return c.json(
        { error: "workspaceId query param (UUID) is required" },
        400
      );
    }

    try {
      const acting = await resolveActingContext(c, { workspaceId });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const capabilities = await buildCapabilityCatalog({
        workspaceId: acting.workspaceId,
        userId: acting.userId,
      });
      return c.json({ capabilities }, 200);
    } catch (err) {
      logger.error({ err }, "capabilities catalog failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
