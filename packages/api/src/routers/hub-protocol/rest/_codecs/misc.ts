/**
 * Misc Wire Codecs — Hub Protocol REST schemas for less-trafficked routes:
 * - mcp-servers
 * - agent-users
 * - terminal logs
 * - vault requests
 * - capture (cluster-tabs / structure / execute)
 * - events
 * - workspaces
 */

import { z } from "@hono/zod-openapi";

/**
 * Optional original-input descriptor carried with a proposal-first graph
 * capture. It is proposal provenance only: approval does not materialize it as
 * a shared source entity or document. Keeping the payload bounded lets review
 * and retry surfaces retain the exact prompt/input without a schema migration.
 */
export const CaptureGraphRawSourceSchema = z
  .object({
    rawText: z.string().max(100_000).optional(),
    sourceUrl: z.string().url().max(4_096).optional(),
    label: z.string().trim().min(1).max(512).optional(),
    mimeType: z.string().max(256).optional(),
    hash: z.string().max(256).optional(),
    idempotencyKey: z.string().max(200).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.rawText !== undefined ||
      value.sourceUrl !== undefined ||
      value.label !== undefined,
    "rawText, sourceUrl, or label is required"
  )
  .openapi("CaptureGraphRawSource");

// ── MCP servers ─────────────────────────────────────────────────────────────

/** Wire shape of an approved MCP server (read-only — IS subset). */
export const WireMcpServerSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    approved: z.boolean(),
    enabled: z.boolean(),
    transport: z.string().nullable().optional(),
  })
  .openapi("McpServer");

/** GET /mcp-servers query. */
export const ListMcpServersQuerySchema = z
  .object({
    workspaceId: z.string().optional(),
  })
  .openapi("ListMcpServersQuery");

// ── Agent users ─────────────────────────────────────────────────────────────

/** Wire shape of an agent user row (subset — what the hub returns to IS). */
export const WireAgentUserSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    agentMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
    role: z.string().nullable().optional(),
  })
  .passthrough()
  .openapi("AgentUser");

/** GET /agent-users query. */
export const ListAgentUsersQuerySchema = z
  .object({
    workspaceId: z.string().optional(),
    parentUserId: z
      .string()
      .optional()
      .describe(
        "Filter agents by agentMetadata.parentAgentId — used by orchestrators to discover their personalities."
      ),
  })
  .openapi("ListAgentUsersQuery");

// ── Terminal logs ───────────────────────────────────────────────────────────

export const TerminalServiceSchema = z
  .enum(["api", "intelligence", "realtime", "postgres", "typesense"])
  .openapi("TerminalService");

/** GET /terminal/logs query. */
export const TerminalLogsQuerySchema = z
  .object({
    service: TerminalServiceSchema,
    lines: z.string().optional().describe("Default 50, hard-capped at 500."),
    since: z
      .string()
      .optional()
      .describe("Time window (e.g. '1h', '30m'). Forwarded to docker --since."),
    filter: z
      .string()
      .optional()
      .describe("grep -i pattern applied to output."),
  })
  .openapi("TerminalLogsQuery");

/** GET /terminal/logs response. */
export const TerminalLogsResponseSchema = z
  .object({
    service: z.string(),
    lines: z.number(),
    truncated: z.boolean(),
    output: z.string(),
  })
  .openapi("TerminalLogsResponse");

// ── Vault ──────────────────────────────────────────────────────────────────

/** POST /vault/request request body. */
export const VaultRequestRequestSchema = z
  .object({
    workspaceId: z.string().optional(),
    agentUserId: z.string().optional(),
    channelId: z.string().optional(),
    sourceMessageId: z.string().optional(),
    secretType: z
      .string()
      .describe("Secret class (e.g. api_key, oauth_token)."),
    service: z.string().describe("Service the secret unlocks (e.g. github)."),
    purpose: z.string().describe("Human-readable rationale shown to the user."),
    accessLevel: z.string().optional().describe("Defaults to 'read'."),
    ttl: z
      .number()
      .optional()
      .describe("Minutes the grant lives. Defaults to 60."),
  })
  .openapi("VaultRequestRequest");

/** POST /vault/request response. */
export const VaultRequestResponseSchema = z
  .object({
    status: z.literal("pending"),
    proposalId: z.string(),
    message: z.string(),
  })
  .openapi("VaultRequestResponse");

// ── Capture ─────────────────────────────────────────────────────────────────

/** POST /capture/cluster-tabs request body. */
export const ClusterTabsRequestSchema = z
  .object({
    tabs: z.array(
      z.object({
        url: z.string(),
        title: z.string(),
        favIconUrl: z.string().optional(),
        tabId: z.number().optional(),
        windowId: z.number().optional(),
      })
    ),
  })
  .openapi("ClusterTabsRequest");

/** POST /capture/cluster-tabs response. */
export const ClusterTabsResponseSchema = z
  .object({
    clusters: z.array(
      z.object({
        name: z.string(),
        icon: z.string(),
        tabs: z.array(
          z
            .object({
              url: z.string(),
              title: z.string(),
              favIconUrl: z.string().optional(),
              tabId: z.number().optional(),
              windowId: z.number().optional(),
            })
            .passthrough()
        ),
      })
    ),
  })
  .openapi("ClusterTabsResponse");

/** POST /capture/structure request body. */
export const CaptureStructureRequestSchema = z
  .object({
    // Optional: when omitted, the route derives the acting user from the
    // API-key principal via resolveActingContext (body.userId ?? authUserId).
    // An explicit value is still honored for trusted on-behalf-of infra calls.
    userId: z.string().optional(),
    // Optional now: a binary input (PDF/photo/docx/audio) can arrive via `file`
    // and be normalized to text by IS's extractor before structuring. At least
    // one of text/file/url must be present (enforced by the refinement below).
    text: z.string().min(1).max(8000).optional(),
    /**
     * Binary/text source normalized to text by IS before structuring. Shape
     * MIRRORS the tRPC capture.structure `file` input (and the IS client's
     * `structure` arg) — `content` is base64/utf8 per `encoding`. Field names
     * must match exactly or the tRPC zod layer strips them on passthrough.
     */
    file: z
      .object({
        content: z.string(),
        mimeType: z.string(),
        filename: z.string().optional(),
        encoding: z.enum(["base64", "utf8"]).optional(),
      })
      .optional(),
    url: z.string().url().optional(),
    html: z.string().max(50_000).optional(),
    context: z.string().optional(),
    // Optional extraction bias (e.g. lead-capture channel intake hint). Passed
    // through to the tRPC capture.structure procedure → IS structuring call.
    instructions: z.string().max(2000).optional(),
    workspaceId: z.string().uuid().optional(),
    previousEntities: z
      .array(
        z.object({
          tempId: z.string(),
          profileSlug: z.string(),
          title: z.string(),
          description: z.string().optional(),
          properties: z.record(z.string(), z.unknown()).optional(),
        })
      )
      .optional(),
  })
  .refine((b) => Boolean(b.text || b.file || b.url), {
    message: "At least one of `text`, `file`, or `url` is required",
  })
  .openapi("CaptureStructureRequest");

/** POST /capture/execute request body. */
export const CaptureExecuteRequestSchema = z
  .object({
    // Optional: derived from the API-key principal when omitted (see above).
    userId: z.string().optional(),
    workspaceId: z.string().uuid().optional(),
    // Optional cross-cutting project lens to file the new entities into. Mirrors
    // the tRPC `capture.execute` input; without this the AI-proposed
    // `targetProjectId` / CLI `--project` is dropped at the REST door.
    projectId: z.string().uuid().nullish(),
    entities: z.array(
      z.object({
        tempId: z.string(),
        profileSlug: z.string(),
        title: z.string(),
        description: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        /**
         * Long-form body. When the document heuristic fires it is materialized
         * into a versioned document (MinIO + document_versions + Typesense) and
         * linked via entity.documentId; otherwise it folds into
         * properties.content.
         */
        content: z.string().optional(),
        existingEntityId: z.string().uuid().optional(),
        // Kind + Facets: role-profiles to attach after the entity materializes.
        // Must match the tRPC capture.execute entity schema exactly or the tRPC
        // zod layer strips it on passthrough. `contextTempId` references another
        // batch entity by tempId.
        facets: z
          .array(
            z.object({
              profileSlug: z.string(),
              status: z.string().optional(),
              properties: z.record(z.string(), z.unknown()).optional(),
              contextTempId: z.string().optional(),
            })
          )
          .optional(),
      })
    ),
    relations: z
      .array(
        z.object({
          sourceTempId: z.string(),
          targetTempId: z.string(),
          relationType: z.string(),
        })
      )
      .optional(),
    /** Explicit placement override from an already-reviewed capture plan. */
    targetWorkspaceId: z.string().uuid().nullish(),
    /** Preserve the original binary source alongside the primary derived entity. */
    keepRaw: z.boolean().optional(),
    /** Base64 source blob, used only when keepRaw is true (max about 5MB binary). */
    file: z
      .object({
        content: z.string().max(7_000_000, "file.content too large (max ~5MB)"),
        mimeType: z.string(),
        filename: z.string().optional(),
      })
      .optional(),
    /** Retry namespace: same key + tempIds links prior entities instead of duplicating. */
    idempotencyKey: z.string().max(200).optional(),
    // Workspace routing (shared with the tRPC capture.execute contract). Forward
    // the AI's structure hints + the caller's mode so this door auto-routes
    // identically to MCP. Without them the capture stays in the ambient workspace.
    workspaceRouting: z.enum(["auto", "ask", "locked"]).optional(),
    aiWorkspaceId: z.string().uuid().nullish(),
    aiWorkspaceConfidence: z.number().nullish(),
    aiWorkspaceReason: z.string().nullish(),
  })
  .openapi("CaptureExecuteRequest");

/**
 * POST /import/analyze and /import/apply request body (shared — both endpoints
 * take the same shape). `source` must stay in sync with the `ImportSource`
 * union in import-adapters.ts; an out-of-date enum here silently 400s sources
 * the engine actually supports.
 */
export const ImportRequestSchema = z
  .object({
    userId: z.string().min(1),
    workspaceId: z.string().uuid().optional(),
    source: z.enum(["obsidian", "markdown", "csv", "bookmark"]),
    /** Relation type for cross-references (default "references"). */
    relationType: z.string().min(1).max(64).optional(),
    /**
     * Route items through AI bulk-structuring to recover real typed profiles +
     * extracted properties (best-effort; falls back to deterministic). Default
     * on; set false for a pure deterministic faithful import.
     */
    aiStructure: z.boolean().optional().default(true),
    items: z
      .array(
        z.object({
          /** Source-relative path, e.g. "Projects/Launch.md". */
          path: z.string().min(1).max(1024),
          content: z.string().max(200_000),
        })
      )
      .min(1)
      .max(2000),
  })
  .openapi("ImportRequest");

// ── Events ──────────────────────────────────────────────────────────────────

/** Wire shape of an event-log row. */
export const WireEventSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    subjectType: z.string().nullable().optional(),
    subjectId: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    timestamp: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough()
  .openapi("Event");

/** GET /events query. */
export const ListEventsQuerySchema = z
  .object({
    userId: z.string(),
    type: z.string().optional(),
    subjectType: z.string().optional(),
    subjectId: z.string().optional(),
    fromDate: z
      .string()
      .optional()
      .describe("ISO timestamp. Defaults to 7 days ago."),
    limit: z.string().optional().describe("Default 50, hard-capped at 200."),
  })
  .openapi("ListEventsQuery");

// ── Workspaces ──────────────────────────────────────────────────────────────

/** GET /workspaces response. */
export const ListWorkspacesResponseSchema = z
  .object({
    workspaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        entityCount: z
          .number()
          .optional()
          .describe("Live (non-deleted) entity count in this workspace."),
      })
    ),
    podEntityCount: z
      .number()
      .optional()
      .describe("Count of pod-scoped entities (workspaceId = null)."),
  })
  .openapi("ListWorkspacesResponse");

/** Eve provider routing policy schema. */
export const EveProviderRoutingSchema = z
  .object({
    mode: z.enum(["local", "provider", "hybrid"]).optional(),
    defaultProvider: z
      .enum(["ollama", "openrouter", "anthropic", "openai"])
      .optional(),
    fallbackProvider: z
      .enum(["ollama", "openrouter", "anthropic", "openai"])
      .optional(),
    providers: z
      .array(
        z.object({
          id: z.enum(["ollama", "openrouter", "anthropic", "openai"]),
          enabled: z.boolean().optional(),
          baseUrl: z.string().optional(),
          defaultModel: z.string().optional(),
        })
      )
      .optional(),
    syncToSynap: z.boolean().optional(),
  })
  .openapi("EveProviderRouting");

/** GET /workspaces/{workspaceId}/eve-provider-routing response. */
export const EveProviderRoutingResponseSchema = z
  .object({
    ok: z.boolean(),
    workspaceId: z.string(),
    eveProviderRouting: EveProviderRoutingSchema.nullable(),
  })
  .openapi("EveProviderRoutingResponse");
