/**
 * Entity Wire Codec — single source of truth for the entity shape returned
 * by Hub Protocol REST endpoints.
 *
 * Replaces the previous duplication between:
 *   - `normalizeHubEntity` (inline in hub-protocol-rest.ts)
 *   - `toApiEntity` (in routers/entities.ts)
 *
 * Accepts either a DB row (entities table) or a Typesense document,
 * normalizes the shape and emits the canonical wire form.
 */

import { z } from "@hono/zod-openapi";

// Canonical wire shape for entities returned by Hub Protocol after passing
// through `entityToWire(...)`. Routes that return raw DB rows directly should
// use `RawEntityRecordSchema` instead — DB rows lack `profileSlug` (only the
// deprecated `type` column) and would fail strict validation.
export const WireEntitySchema = z
  .object({
    id: z.string(),
    profileSlug: z.string(),
    type: z.string(), // deprecated alias === profileSlug, kept for back-compat
    title: z.string().nullable().optional(),
    preview: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    properties: z.record(z.string(), z.unknown()),
    systemData: z.record(z.string(), z.unknown()).optional(),
    userId: z.string(),
    workspaceId: z.string().nullable().optional(),
    documentId: z.string().nullable().optional(),
    version: z.number().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .openapi("Entity");
export type WireEntity = z.infer<typeof WireEntitySchema>;

/**
 * Loose record schema for routes that return raw entity rows from the DB
 * (e.g. GET /entities/:id, GET /users/:userId/entities). DB rows have `type`
 * but no `profileSlug` and may carry extra system columns — modelling them
 * with `WireEntitySchema` would fail. Keep the contract loose and let
 * sidecars/clients normalize on their end. The strict shape is kept in
 * `WireEntitySchema` for the routes that explicitly map through `entityToWire`.
 */
export const RawEntityRecordSchema = z
  .record(z.string(), z.unknown())
  .openapi("RawEntityRecord");

/** POST /entities request body. */
export const CreateEntityRequestSchema = z
  .object({
    userId: z
      .string()
      .optional()
      .describe("Owner of the entity. Defaults to the authenticated user."),
    agentUserId: z
      .string()
      .optional()
      .describe(
        "Agent user that performed the write. Used for proposal authorship."
      ),
    workspaceId: z
      .string()
      .optional()
      .describe(
        "Target workspace. Falls back to profile.entityScope and the user's first accessible workspace."
      ),
    projectId: z
      .string()
      .optional()
      .describe(
        "File the new entity into a project (its entity id). Stamps a belongs_to_project edge at materialization, so project-scoped recall (ask with projectId) finds it. Orthogonal to workspaceId."
      ),
    profileSlug: z
      .string()
      .optional()
      .describe(
        "Profile slug. Provide profileSlug, profileId, or the deprecated `type` alias."
      ),
    profileId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Profile UUID. Resolved to the profile's slug server-side; takes precedence over profileSlug/type."
      ),
    type: z
      .string()
      .optional()
      .describe("Deprecated alias for profileSlug. Prefer profileSlug."),
    title: z.string(),
    description: z.string().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    content: z
      .string()
      .optional()
      .describe(
        "Long-form markdown body. When set, a linked, versioned document is created (MinIO-stored) instead of inlining into properties."
      ),
    reasoning: z
      .string()
      .optional()
      .describe(
        "The proposing agent's rationale for this action, surfaced in the proposal inbox."
      ),
    source: z
      .enum([
        "intelligence",
        "agent",
        "openwebui-pipeline",
        "extension",
        "cli",
        "n8n",
        "raycast",
      ])
      .optional()
      .describe("Origin signal for downstream attribution."),
    sourceMessageId: z
      .string()
      .optional()
      .describe(
        "Optional message ID that triggered this write (for event chain causality)."
      ),
    sessionId: z
      .string()
      .optional()
      .describe(
        "Optional session ID to link proposals created by this write to an active focus session."
      ),
    facets: z
      .array(
        // Accept `profileSlug` as an alias for `slug` — the /structure and tRPC
        // facet contracts name the role's identifier `profileSlug`, and BYOA
        // integrators reasonably reuse that shape here (live 400 observed
        // 2026-07-11 when a dogfood client sent profileSlug). Canonical wire
        // name stays `slug`; the alias is normalized before validation.
        z.preprocess(
          (raw) => {
            if (
              raw &&
              typeof raw === "object" &&
              !("slug" in raw) &&
              "profileSlug" in raw &&
              typeof (raw as { profileSlug: unknown }).profileSlug === "string"
            ) {
              const { profileSlug, ...rest } = raw as Record<string, unknown>;
              return { ...rest, slug: profileSlug };
            }
            return raw;
          },
          z.object({
            slug: z.string(),
            properties: z.record(z.string(), z.unknown()).optional(),
          })
        )
      )
      .optional()
      .describe(
        "Kind + Facets: role-profiles to attach to the new entity in the same call (each via the governed attachFacet door). Applied only when the entity materializes. `slug` is canonical; `profileSlug` is accepted as an alias for parity with the /structure and tRPC facet shapes."
      ),
    forceCreate: z
      .boolean()
      .optional()
      .describe(
        "Bypass the weak same-name create gate when a same-profile entity with this title already exists. Prefer reusing the existing id. Does not bypass strong-signal auto-merge (email/phone/url)."
      ),
  })
  .openapi("CreateEntityRequest");

/** PATCH /entities/:entityId request body. */
export const UpdateEntityRequestSchema = z
  .object({
    userId: z.string(),
    agentUserId: z.string().optional(),
    workspaceId: z.string().nullable().optional(),
    title: z.string().optional(),
    preview: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** Keys to remove from the entity's properties object. Applied before `metadata` merge. */
    deleteProperties: z.array(z.string()).optional(),
    reasoning: z
      .string()
      .optional()
      .describe(
        "The proposing agent's rationale for this update, surfaced in the proposal inbox."
      ),
    sourceMessageId: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .openapi("UpdateEntityRequest");

/** Response shape for POST /entities.
 *
 * Mirrors `caller.entities.createEntity()` output (status / message / id /
 * proposalId / workspaceId) plus the `effectiveWorkspaceId` echo the route
 * adds on top so callers can confirm where a pod-wide entity actually landed.
 */
export const CreateEntityResponseSchema = z
  .object({
    status: z.string().describe("e.g. 'created' or 'proposed'."),
    message: z.string().optional(),
    id: z.string().optional(),
    proposalId: z.string().nullable().optional(),
    proposedEntityId: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    effectiveWorkspaceId: z
      .string()
      .nullable()
      .describe(
        "Workspace the entity actually landed in. May be null for pod-wide profiles."
      ),
    proposalType: z
      .string()
      .optional()
      .describe(
        'Present when status is "proposed". "join" for a workspace-join gate, else "<subject>.<action>" (e.g. "entity.create").'
      ),
    reviewUrl: z
      .string()
      .optional()
      .describe(
        'Present when status is "proposed". Absolute URL to review the proposal in the Studio.'
      ),
    facets: z
      .array(
        z.object({
          slug: z.string(),
          status: z.string(),
          facetId: z.string().optional(),
          proposalId: z.string().optional(),
          error: z.string().optional(),
        })
      )
      .optional()
      .describe(
        "Kind + Facets: per-role attach outcome for any `facets` passed in the request (status attached/proposed/error)."
      ),
    /**
     * Additive, write-aware receipt. `pending` means only a proposal exists;
     * `partial` means independent follow-up operations failed after the entity
     * write applied — it never claims an atomic rollback.
     */
    writeReceipt: z
      .object({
        state: z.enum(["pending", "applied", "partial"]),
        proposalId: z.string().optional(),
        reviewUrl: z.string().optional(),
        entityId: z.string().optional(),
        proposedEntityId: z.string().optional(),
        profileSlug: z.string().optional(),
        effectiveWorkspaceId: z.string().nullable().optional(),
        projectId: z.string().optional(),
        source: z.string().optional(),
        facets: z
          .array(
            z.object({
              slug: z.string(),
              outcome: z.string(),
              facetId: z.string().optional(),
              proposalId: z.string().optional(),
              error: z.string().optional(),
            })
          )
          .optional(),
        warnings: z.array(z.string()).optional(),
        properties: z
          .object({
            unmodeled: z
              .array(
                z.object({
                  key: z.string(),
                  didYouMean: z
                    .string()
                    .optional()
                    .describe(
                      "Closest valid property slug, when the key looks like a typo."
                    ),
                })
              )
              .describe(
                "Property keys written but NOT modelled by the profile. Stored verbatim (the write succeeded) but not queryable."
              ),
          })
          .optional()
          .describe(
            "Present only when the write carried keys the profile does not model."
          ),
      })
      .optional(),
  })
  .openapi("CreateEntityResponse");

/** Response shape for PATCH /entities/:entityId.
 *
 * `caller.entities.updateEntity` returns either a "proposed" envelope (with
 * proposalId + summary/reasoning/review fields) or a plain status echo. We
 * model the union as a wide object since OpenAPI consumers can branch on
 * `status`.
 */
export const UpdateEntityResponseSchema = z
  .object({
    status: z.string(),
    message: z.string().optional(),
    proposalId: z.string().nullable().optional(),
    summary: z.string().optional(),
    reasoning: z.string().optional(),
    reviewPath: z.string().optional(),
    reviewUrl: z.string().optional(),
  })
  .openapi("UpdateEntityResponse");

/**
 * Normalize either a DB row (entities table) or a Typesense document
 * into the canonical wire shape. Single source of truth — replaces
 * normalizeHubEntity and toApiEntity.
 */
export function entityToWire(entity: unknown): WireEntity {
  if (!entity || typeof entity !== "object") {
    throw new TypeError("entityToWire: expected an object");
  }
  const row = entity as Record<string, unknown>;
  const slug =
    (typeof row.profileSlug === "string" && row.profileSlug) ||
    (typeof row.type === "string" && row.type) ||
    (typeof row.entityType === "string" && row.entityType) ||
    "note";
  return {
    id: String(row.id),
    profileSlug: slug,
    type: slug, // alias
    title: (row.title as string | null | undefined) ?? null,
    preview: (row.preview as string | null | undefined) ?? null,
    description: (row.description as string | null | undefined) ?? undefined,
    properties: (row.properties as Record<string, unknown>) ?? {},
    systemData: (row.systemData as Record<string, unknown>) ?? {},
    userId: String(row.userId ?? row.user_id ?? ""),
    workspaceId:
      ((row.workspaceId ?? row.workspace_id) as string | null | undefined) ??
      null,
    documentId:
      ((row.documentId ?? row.document_id) as string | null | undefined) ??
      null,
    version: typeof row.version === "number" ? row.version : undefined,
    createdAt: row.createdAt as string | Date | undefined,
    updatedAt: row.updatedAt as string | Date | undefined,
  };
}
