/**
 * Hub Protocol REST — Public Projection (UNAUTHENTICATED, read-only).
 *
 * `GET /public/projection?workspace=<id>&q=<text>&role=<slug>&limit=<n>`
 *
 * WHY THIS EXISTS
 * An external product can mirror public records into a Synap workspace and needs
 * an unauthenticated, read-only search over ONLY that public data for a public
 * landing page. This endpoint is PRODUCT-AGNOSTIC — it names no product, role, or
 * field. Everything it exposes is declared per-workspace in
 * `workspace.settings.publicProjection` (default-deny opt-in).
 *
 * THE SECURITY KEYSTONE — facet-scoping, NOT entity-scoping
 * `company` / `person` atoms are POD-WIDE (`entities.workspace_id` NULL): they
 * appear in EVERY workspace lens. So "entities WHERE entity.workspace_id = X" is
 * the WRONG filter — it leaks the pod's private CRM/notes. The CORRECT filter is:
 * entities that HAVE A LIVE FACET whose `entity_facets.workspace_id = X` and whose
 * facet profile slug is in the workspace's explicit `roles` allowlist. A mirrored
 * public record = a pod-wide entity + a facet planted in THIS workspace. We query
 * by the FACET's workspace_id (see {@link runProjectionQuery}). A pod-wide private
 * person/note has no such facet and therefore can never appear.
 *
 * Every output row is field-whitelisted server-side against `fields`; raw
 * properties are never dumped. `limit` is hard-capped. Not opted in ⇒ 404 (we do
 * not reveal that the workspace exists).
 */

import { z } from "@hono/zod-openapi";
import {
  db,
  entities,
  entityFacets,
  profiles,
  workspaces,
  eq,
  and,
  or,
  inArray,
  isNull,
  ilike,
} from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  PublicProjectionQuerySchema,
  PublicProjectionResponseSchema,
} from "./_codecs/public-projection.js";
import { logger, type HubHono } from "./_shared.js";

/** Default page size when `limit` is omitted or unparseable. */
export const PROJECTION_DEFAULT_LIMIT = 20;
/** Hard ceiling — no full-pod enumeration. */
export const PROJECTION_MAX_LIMIT = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validated public-projection config. `enabled` MUST be the boolean `true` and at
 * least one role MUST be declared, else the workspace is treated as not opted in.
 */
const PublicProjectionConfigSchema = z.object({
  enabled: z.literal(true),
  roles: z.array(z.string().min(1)).min(1),
  fields: z.array(z.string().min(1)).default([]),
});

export type PublicProjectionConfig = z.infer<typeof PublicProjectionConfigSchema>;

/**
 * Read + validate `settings.publicProjection`. Returns the config ONLY when the
 * workspace has explicitly opted in (`enabled === true` and ≥1 role). Any other
 * shape — absent, `enabled: false`, empty roles, malformed — returns `null`,
 * which the handler maps to 404. Default-deny.
 */
export function parsePublicProjectionConfig(
  settings: unknown
): PublicProjectionConfig | null {
  if (!settings || typeof settings !== "object") return null;
  const raw = (settings as Record<string, unknown>).publicProjection;
  const parsed = PublicProjectionConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Query filter spec derived from the request + the workspace's config. */
export interface ProjectionSpec {
  /** SECURITY: this is the FACET workspace_id filter — the keystone. */
  facetWorkspaceId: string;
  /** Role slugs to match — ALWAYS a subset of the config allowlist. */
  roleSlugs: string[];
  /** Sanitized keyword (LIKE wildcards escaped), or null. */
  keyword: string | null;
  /** Effective, capped page size. */
  limit: number;
}

/** Escape LIKE metacharacters so `q` cannot inject wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Parse + clamp the `limit` query param to [1, PROJECTION_MAX_LIMIT]. */
export function clampLimit(raw: string | undefined): number {
  if (!raw) return PROJECTION_DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return PROJECTION_DEFAULT_LIMIT;
  return Math.min(n, PROJECTION_MAX_LIMIT);
}

/**
 * Resolve which role slugs the query filters on. An out-of-allowlist `role` is
 * NEVER honored — it falls back to the full allowlist (so the request can never
 * widen exposure beyond what the workspace declared). An in-allowlist `role`
 * narrows to that single slug.
 */
export function resolveRoleSlugs(
  requested: string | undefined,
  allowed: string[]
): string[] {
  if (requested && allowed.includes(requested)) return [requested];
  return allowed;
}

/**
 * Build the immutable query spec from a validated config + request params.
 * Pure — no DB access — so the security invariants (facet-scoping, role-allowlist
 * subset, limit cap) are unit-testable without a database.
 */
export function buildProjectionSpec(
  config: PublicProjectionConfig,
  params: { workspaceId: string; q?: string; role?: string; limit?: string }
): ProjectionSpec {
  return {
    facetWorkspaceId: params.workspaceId,
    roleSlugs: resolveRoleSlugs(params.role, config.roles),
    keyword: params.q && params.q.trim() ? escapeLike(params.q.trim()) : null,
    limit: clampLimit(params.limit),
  };
}

/** A raw joined row before field-whitelisting. */
export interface ProjectionRow {
  id: string;
  title: string | null;
  role: string;
  entityProperties: unknown;
  facetProperties: unknown;
}

/** A projected, field-whitelisted output item. */
export interface ProjectionItem {
  id: string;
  title: string | null;
  role: string;
  properties: Record<string, unknown>;
}

/**
 * Project one joined row down to the public shape. Only keys present in `fields`
 * survive. Facet properties overlay entity properties (role-specific data wins),
 * but the key allowlist is applied AFTER the merge, so no private key can leak
 * regardless of which side it came from.
 */
export function projectRow(
  row: ProjectionRow,
  fields: string[]
): ProjectionItem {
  const entityProps =
    row.entityProperties && typeof row.entityProperties === "object"
      ? (row.entityProperties as Record<string, unknown>)
      : {};
  const facetProps =
    row.facetProperties && typeof row.facetProperties === "object"
      ? (row.facetProperties as Record<string, unknown>)
      : {};
  const properties: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in facetProps) properties[key] = facetProps[key];
    else if (key in entityProps) properties[key] = entityProps[key];
  }
  return { id: row.id, title: row.title, role: row.role, properties };
}

/**
 * Execute the facet-scoped projection query. THIS is where the security keystone
 * lives: the WHERE binds `entity_facets.workspace_id = spec.facetWorkspaceId` and
 * `profiles.slug IN spec.roleSlugs`. It joins facet → profile (for the slug) and
 * facet → entity (for title/properties). Only live (non-soft-deleted) facets and
 * entities are considered. No offset — capped limit only.
 */
async function runProjectionQuery(spec: ProjectionSpec): Promise<ProjectionRow[]> {
  const conditions = [
    // KEYSTONE — filter by the FACET's workspace, NOT the entity's.
    eq(entityFacets.workspaceId, spec.facetWorkspaceId),
    inArray(profiles.slug, spec.roleSlugs),
    isNull(entityFacets.deletedAt),
    isNull(entities.deletedAt),
  ];
  if (spec.keyword) {
    const pattern = `%${spec.keyword}%`;
    conditions.push(
      or(ilike(entities.title, pattern), ilike(entities.preview, pattern))!
    );
  }

  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      role: profiles.slug,
      entityProperties: entities.properties,
      facetProperties: entityFacets.properties,
    })
    .from(entityFacets)
    .innerJoin(profiles, eq(entityFacets.profileId, profiles.id))
    .innerJoin(entities, eq(entityFacets.entityId, entities.id))
    .where(and(...conditions))
    .limit(spec.limit);

  return rows as ProjectionRow[];
}

export function registerPublicProjectionRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/public/projection",
    tags: ["Public"],
    summary: "Unauthenticated, field-whitelisted public projection of a workspace",
    description:
      "Read-only search over the facet-scoped public data a workspace opts into " +
      "via settings.publicProjection. No auth. Returns 404 when the workspace has " +
      "not opted in.",
    security: [],
    request: { query: PublicProjectionQuerySchema },
    responses: {
      200: {
        description: "Field-whitelisted projection items",
        schema: PublicProjectionResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      404: { description: "No public projection for this workspace", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /public/projection — UNAUTHENTICATED. Listed in `skipAuthPaths`.
   */
  app.get("/public/projection", async (c) => {
    const workspaceId = c.req.query("workspace");
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
      // Invalid/absent id — 404 (never reveal existence, never let a bad id
      // reach Postgres and 500 on invalid-uuid syntax).
      return c.json({ error: "Not found" }, 404);
    }

    try {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { settings: true },
      });

      const config = parsePublicProjectionConfig(workspace?.settings);
      if (!config) {
        // Default-deny: not opted in (or no such workspace) ⇒ 404, no data.
        return c.json({ error: "Not found" }, 404);
      }

      const spec = buildProjectionSpec(config, {
        workspaceId,
        q: c.req.query("q"),
        role: c.req.query("role"),
        limit: c.req.query("limit"),
      });

      const rows = await runProjectionQuery(spec);
      const items = rows.map((row) => projectRow(row, config.fields));
      return c.json({ items, count: items.length });
    } catch (err) {
      logger.error({ err, workspaceId }, "public projection query failed");
      return c.json({ error: "Internal error" }, 500);
    }
  });
}
