/**
 * Views Router - Production-Ready
 *
 * Handles:
 * - View CRUD (whiteboards, timelines, kanban, etc.)
 * - Content loading/saving
 * - Integration with documents table
 * - Query execution with filters and sorts
 * - Manual entity ordering
 *
 * Architecture: Synchronous CRUD
 * - All write operations are direct DB calls
 * - Audit logging via events table (fire-and-forget)
 * - Side-effects (search indexing, webhooks) via pg-boss queue
 */

import { z } from "zod";
import { createLogger } from "@synap-core/core";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import { storage } from "@synap/storage";
import {
  db,
  eq,
  and,
  desc,
  sql as pgSql,
  sqlTemplate as sql,
  inArray,
  or,
  isNull,
  isNotNull,
  getTableColumns,
  asc,
  type SQL,
  views,
  workspaces,
  documents,
  documentVersions,
  entities,
  profiles,
  relations,
  profileScopeConditions,
  loadFacetSlugsBatch,
  ViewFilterCompiler,
  PropertyMergingService,
  ViewDefaultColumnsService,
  getDb,
  eventRepository,
  ViewRepository,
  WorkspaceRepository,
  ProfileRepository,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { ViewEvents } from "../lib/event-helpers.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { verifyPermission, getWorkspaceMembership } from "@synap/database";
import {
  checkPermissionOrPropose,
  previewPermissionDecision,
} from "../utils/permission-check.js";
import { randomUUID } from "crypto";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
import { resolveFacetVisibilityScope } from "../utils/workspace-membership.js";
import {
  userVisibleWhere,
  workspaceLensWhere,
} from "../utils/user-visible-where.js";
import { projectLensWhere, accessScopeWhere } from "../utils/project-scope.js";

function viewVisibleWhere(userId: string) {
  return or(
    and(isNull(views.workspaceId), eq(views.userId, userId)),
    and(
      isNotNull(views.workspaceId),
      userVisibleWhere(views.workspaceId, userId)
    )
  )!;
}

function viewLensWhere(
  userId: string,
  lens?: string | null,
  opts?: { includePodWide?: boolean }
) {
  if (lens === undefined) return viewVisibleWhere(userId);
  if (lens === null)
    return and(isNull(views.workspaceId), eq(views.userId, userId))!;
  const workspaceBranch = workspaceLensWhere(views.workspaceId, userId, lens);
  if (!opts?.includePodWide) return workspaceBranch;
  return or(
    and(isNull(views.workspaceId), eq(views.userId, userId)),
    workspaceBranch
  )!;
}

// The entity floor for VIEW content — routed through the one door, identical to
// `entities.ts` `entityLensWhere`, so a structured view (kanban/gallery/table/
// feed/bento) resolves entities with the SAME visibility as `entities.list`:
// role-as-lens (facetLens) + full exposure (project + visible_to). Previously
// hand-rolled with owner-only pod-wide + project-only exposure, so a role-shared
// entity was invisible in a co-member's view while showing in their list.
function entityLensWhereForViews(
  userId: string,
  lens: string | null | undefined,
  includePodWide: boolean
) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    workspaceLens: lens,
    facetLens: true,
    includeGlobalsInLens: includePodWide,
  });
}

// Proper package imports
import {
  ViewContentSchema,
  getViewCategory,
  validateViewConfig,
  ViewTypeEnum,
  type ViewMetadata,
  type EntityFilter,
  type SortRule,
  type EntityQuery,
} from "@synap-core/types";

const logger = createLogger({ module: "views" });

/**
 * The ONLY two renderer bindings a view may store.
 *
 * `config.rendererRef` is the sovereign per-view renderer binding read by the
 * render chokepoint (`StructuredViewRenderer`). Until now the door accepted
 * `config` as an opaque `z.record(z.string(), z.any())`, so ANY `RendererTarget`
 * shape could be persisted — including `{ kind: "iframe-srcdoc", srcdoc }`,
 * which names raw HTML to mount. Only a FRONTEND gate kept a tampered binding
 * inert; nothing stopped it from being STORED.
 *
 * These two are what the picker (`ViewConfigInspector.handleRendererChange`)
 * actually writes, and the only two the chokepoint honours for a view. Every
 * other `RendererTarget` kind (`iframe-srcdoc`, `host-app`, `view`, …) is
 * rejected at the door — a view binding has no use for them.
 *
 * NOT `.strict()`: unknown sibling keys are tolerated so a future additive field
 * doesn't 400 an otherwise valid binding. The narrow is on the DISCRIMINANT and
 * the identifying key, which is what decides what gets mounted.
 */
const ViewRendererRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cell"),
    cellKey: z.string().min(1).max(200),
    contractVersion: z.string().max(32).optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    title: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal("view-adapter"),
    adapterKey: z.string().min(1).max(200),
    contractVersion: z.string().max(32).optional(),
    title: z.string().max(200).optional(),
  }),
]);

/**
 * Reject a view config carrying a renderer binding that is not one of the two
 * legal shapes. Checks BOTH the flat `config.rendererRef` the picker writes and
 * a nested `config.render.rendererRef`, since the chokepoint maps
 * `view.config → RenderSettings` and either nesting could reach it.
 * Absent binding ⇒ no-op, so every existing config still validates.
 */
function assertValidRendererRef(config: Record<string, unknown>): void {
  const nested = config.render;
  const candidates: unknown[] = [config.rendererRef];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    candidates.push((nested as Record<string, unknown>).rendererRef);
  }
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const parsed = ViewRendererRefSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          'Invalid renderer binding: config.rendererRef must be { kind: "cell", cellKey } or { kind: "view-adapter", adapterKey }.',
        cause: parsed.error,
      });
    }
  }
}

/**
 * Load the existing view a create would DUPLICATE, keyed on the view's app-level
 * identity: **(workspaceId, lower(name), type)**, unpinned (`project_id IS NULL`).
 *
 * WHY THIS KEY — `views` has NO name-uniqueness index (only
 * `views_scoped_surface_uniq_idx`, which constrains MARKED canonical surfaces on
 * `(type, workspace_id, project_id)`), and no soft-delete/archive column, so a
 * duplicate create genuinely materialises a clone. The key mirrors the two
 * places the codebase already treats a view as identified:
 *   - `reconcile-workspace-from-definition.ts` matches on (workspaceId, name);
 *   - the scoped-surface unique index includes `type` and the project scope.
 * `type` is kept in the key because a "Tasks" kanban and a "Tasks" table are
 * legitimately different surfaces; `project_id IS NULL` because this door never
 * accepts a projectId, so a project-pinned surface must never be handed back as
 * "the existing one". Name match is case-insensitive, oldest-wins — the same
 * rule `findNonArchivedPlaybookByName` uses.
 *
 * FOLLOW-UP (deliberately NOT in this wave): a partial unique index on
 * (workspace_id, lower(name), type) WHERE project_id IS NULL would make this a
 * DB-enforced invariant, but existing pods almost certainly already hold
 * duplicates, so it needs a soft-reconcile migration of its own.
 */
async function findViewByIdentity(
  database: Awaited<ReturnType<typeof getDb>>,
  workspaceId: string,
  name: string,
  type: string
) {
  const [row] = await database
    .select()
    .from(views)
    .where(
      and(
        eq(views.workspaceId, workspaceId),
        isNull(views.projectId),
        eq(views.type, type),
        sql`lower(${views.name}) = lower(${name})`
      )
    )
    .orderBy(asc(views.createdAt), asc(views.id))
    .limit(1);
  return row ?? null;
}

export const viewsRouter = router({
  /**
   * Create a new view (Synchronous: Direct DB insert)
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        // Specific validation for view types and custom constraints
        // Uses ViewTypeEnum from @synap-core/types for single source of truth
        type: ViewTypeEnum,
        // NEW: Scope profiles (required for structured views)
        scopeProfileIds: z.array(z.string().uuid()).optional(),
        scopeMode: z.enum(["explicit", "observed"]).optional(),
        // NEW: Consolidated query
        query: z
          .object({
            filters: z.array(z.any()).optional(),
            sorts: z.array(z.any()).optional(),
            search: z.string().optional(),
            limit: z.number().optional(),
            offset: z.number().optional(),
            groupBy: z.string().optional(),
          })
          .optional(),
        // NEW: Render config (overrides only)
        config: z.record(z.string(), z.any()).optional(),
        // NEW: Embedded view IDs (for composite views)
        embeddedViewIds: z.array(z.string().uuid()).optional(),
        // Optional metadata (e.g. homeScope: 'user' for user-scoped Home)
        metadata: z.record(z.string(), z.any()).optional(),
        // Legacy: initialContent (for canvas views)
        initialContent: z.any().optional(),
        source: z.enum(["user", "ai", "intelligence", "system"]).optional(),
        reasoning: z.string().optional(),
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const correlationId = randomUUID();

      // Resolve placement: omitted workspace means an intentional pod-wide view.
      const effectiveWorkspaceId = input.workspaceId ?? ctx.workspaceId ?? null;

      // Emit .requested before the proposal gate so pending proposals are tied
      // to a real event-chain node.
      const requestedEvent = await auditLog({
        subjectType: "view",
        action: "create",
        phase: "requested",
        subjectId: correlationId,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        correlationId,
        data: { name: input.name, type: input.type },
      });

      // If workspace available, check permissions (including AI proposal gate)
      if (effectiveWorkspaceId) {
        const gateOpts = {
          userId: ctx.userId,
          agentUserId: input.agentUserId,
          workspaceId: effectiveWorkspaceId,
          subjectType: "view",
          action: "create",
          source: input.source,
          reasoning: input.reasoning,
          correlationId,
          requestedEventId: requestedEvent?.id,
          data: {
            name: input.name,
            type: input.type,
            scopeProfileIds: input.scopeProfileIds,
          },
        };

        // IDEMPOTENCY ABOVE THE PROPOSE PATH (AI callers only).
        //
        // Unlike playbooks/automations there is no unique index here, so an
        // approved duplicate materialises a real clone view — and on the propose
        // path an agent re-running the same intent filed a fresh proposal every
        // time (payload dedup can't collapse them; only the NAME is stable).
        //
        // ORDER IS LOAD-BEARING: dry-run the SAME governance door first and
        // re-throw a deny exactly as the real gate would, BEFORE the existence
        // lookup — a caller who may not write must never learn whether the view
        // exists. HUMAN callers are untouched (a person may legitimately want a
        // second view with the same name), so this only short-circuits AI writes.
        const isAiCaller =
          Boolean(input.agentUserId) ||
          input.source === "ai" ||
          input.source === "intelligence";
        if (isAiCaller) {
          const preview = await previewPermissionDecision(gateOpts);
          if (preview.decision === "deny") {
            throw new TRPCError({ code: "FORBIDDEN", message: preview.reason });
          }
          const existingView = await findViewByIdentity(
            await getDb(),
            effectiveWorkspaceId,
            input.name,
            input.type
          );
          if (existingView) {
            return {
              view: existingView,
              documentId: existingView.documentId,
              status: "created",
            };
          }
        }

        const perm = await checkPermissionOrPropose(gateOpts);

        if ("denied" in perm && perm.denied) {
          throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
        }
        if ("proposalId" in perm) {
          return {
            view: null as Record<string, unknown> | null,
            documentId: null as string | null,
            status: "proposed" as const,
            message: "View creation proposed for review",
            proposalId: perm.proposalId,
          };
        }
      }

      // Compute category from view type
      const category = getViewCategory(input.type);

      // Validate scopeProfileIds for structured views
      if (category === "structured") {
        if (!input.scopeProfileIds || input.scopeProfileIds.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "scopeProfileIds is required for structured views",
          });
        }
      }

      // Validate initial content if provided (canvas views)
      if (input.initialContent && category === "canvas") {
        const parseResult = ViewContentSchema.safeParse(input.initialContent);
        if (!parseResult.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid view content structure",
            cause: parseResult.error,
          });
        }

        if (parseResult.data.category !== category) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `View type '${input.type}' requires '${category}' content, got '${parseResult.data.category}'`,
          });
        }
      }

      // Validate config against view type schema
      if (input.config) {
        const validation = validateViewConfig(input.type, input.config);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid view config",
            cause: validation.errors,
          });
        }
        assertValidRendererRef(input.config);
      }

      // Audit: log the requested event
      await ViewEvents.createRequested(ctx.userId, {
        type: input.type,
        name: input.name as string,
        workspaceId: effectiveWorkspaceId ?? undefined,
      });

      const { randomUUID: genId } = await import("crypto");
      const viewId = genId();

      // Canvas views (whiteboard, mindmap) need a document for Yjs + MinIO + versioning.
      // Structured and bento views store their config directly in views.config (JSONB) —
      // no document needed.
      let docId: string | null = null;
      if (category === "canvas") {
        const initialContent = input.initialContent || {};
        const contentStr = JSON.stringify(initialContent);
        const contentBuffer = Buffer.from(contentStr, "utf-8");

        const ext = "json";
        const storageKey = storage.buildPath(
          ctx.userId,
          input.type,
          viewId,
          ext
        );
        const uploadResult = await storage.upload(storageKey, contentBuffer, {
          contentType: "application/json",
        });

        docId = genId();
        const versionId = randomUUID();
        const snapshot = await uploadDocumentVersionSnapshot({
          userId: ctx.userId,
          documentId: docId,
          versionId,
          documentType: input.type,
          mimeType: "application/json",
          content: contentStr,
        });

        const [doc] = await db
          .insert(documents)
          .values({
            id: docId,
            userId: ctx.userId,
            workspaceId: effectiveWorkspaceId ?? undefined,
            type: input.type,
            title: input.name,
            storageUrl: uploadResult.url,
            storageKey: uploadResult.path,
            size: uploadResult.size,
            mimeType: "application/json",
            currentVersion: 1,
            lastSavedVersion: 1,
          })
          .returning();

        await db.insert(documentVersions).values({
          id: versionId,
          documentId: doc.id,
          version: 1,
          ...storedVersionValues(snapshot),
          author: "user",
          authorId: ctx.userId,
          message: "Initial version",
        });
      }

      // Create view
      const baseMetadata = {
        entityCount: 0,
        createdBy: ctx.userId,
        ...input.metadata,
      };

      // Canvas views need a yjsRoomId for Yjs collaboration
      const yjsRoomId = docId ? `whiteboard-${docId}` : undefined;

      const dbInstance = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const viewRepo = new ViewRepository(dbInstance, eventRepo);

      const createdView = await viewRepo.create(
        {
          id: viewId,
          type: input.type,
          name: input.name,
          description: input.description,
          documentId: docId,
          yjsRoomId,
          workspaceId: effectiveWorkspaceId,
          userId: ctx.userId,
          scopeProfileIds: input.scopeProfileIds,
          scopeMode: input.scopeMode || "explicit",
          query: (input.query || {}) as Record<string, unknown>,
          config: (input.config || {}) as Record<string, unknown>,
          embeddedViewIds: input.embeddedViewIds || [],
          metadata: baseMetadata,
        },
        ctx.userId
      );

      // Emit .completed event
      auditLog({
        subjectType: "view",
        action: "create",
        phase: "completed",
        subjectId: viewId,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        correlationId,
        data: {
          id: viewId,
          type: input.type,
          name: input.name,
          ...(docId ? { documentId: docId } : {}),
        },
      });

      // Side-effects (search indexing, webhooks — fire-and-forget)
      emitSideEffects({
        subjectType: "view",
        action: "create",
        subjectId: viewId,
        userId: ctx.userId,
        workspaceId: effectiveWorkspaceId,
        data: {
          id: viewId,
          type: input.type,
          name: input.name,
        },
      });

      return { view: createdView, documentId: docId, status: "created" };
    }),

  /**
   * List views
   */
  list: protectedProcedure
    .input(
      paginatedInput.extend({
        /** Strict workspace lens. Pod-wide views are excluded by default. */
        workspaceIds: z.array(z.string().uuid()).optional(),
        /** Explicit lens. `null` returns pod-wide/user-owned views only. */
        workspaceId: z.string().uuid().nullable().optional(),
        /** Compatibility escape hatch. Keep false for clean workspace lenses. */
        includePodWide: z.boolean().optional().default(false),
        type: z
          .enum([
            "whiteboard",
            "timeline",
            "kanban",
            "table",
            "list",
            "grid",
            "gallery",
            "calendar",
            "gantt",
            "mindmap",
            "graph",
            "all",
          ])
          .optional(),
        /** When true, exclude views that were auto-created by bento block picker */
        excludeAutoCreated: z.boolean().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const workspaceCondition =
        input.workspaceIds && input.workspaceIds.length > 0
          ? and(
              inArray(views.workspaceId, input.workspaceIds),
              viewVisibleWhere(ctx.userId)
            )
          : input.workspaceId !== undefined
            ? viewLensWhere(ctx.userId, input.workspaceId, {
                includePodWide: input.includePodWide,
              })
            : ctx.workspaceId
              ? viewLensWhere(ctx.userId, ctx.workspaceId, {
                  includePodWide: input.includePodWide,
                })
              : viewVisibleWhere(ctx.userId);

      const results = await db.query.views.findMany({
        where: and(
          workspaceCondition,
          input.type && input.type !== "all"
            ? eq(views.type, input.type)
            : undefined,
          input.excludeAutoCreated
            ? sql`(${views.metadata}->>'autoCreated') IS DISTINCT FROM 'true'`
            : undefined
        ),
        orderBy: [desc(views.updatedAt)],
        limit: input.limit + 1,
        offset: input.offset,
      });

      return buildPaginatedResponse(results, input);
    }),

  /**
   * Get Home bento view for a workspace (workspace-level, user-level, or effective).
   * - effective: user home if exists, else workspace home
   * - workspace: base home (admin-only edit)
   * - user: current user's home (null if not created)
   */
  getHome: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        scope: z.enum(["workspace", "user", "effective"]).default("effective"),
      })
    )
    .query(async ({ input, ctx }) => {
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: input.workspaceId },
        requiredPermission: "read",
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason ?? "Insufficient permissions",
        });

      const homeScope = (m: unknown) =>
        (m as Record<string, string> | null)?.homeScope;

      if (input.scope === "user" || input.scope === "effective") {
        const bentoViews = await db.query.views.findMany({
          where: and(
            eq(views.workspaceId, input.workspaceId),
            eq(views.type, "bento"),
            eq(views.userId, ctx.userId)
          ),
        });
        const userHome = bentoViews.find(
          (v) => homeScope(v.metadata) === "user"
        );
        if (userHome) return { view: userHome };
        if (input.scope === "user") return { view: null };
      }

      const bentoViews = await db.query.views.findMany({
        where: and(
          eq(views.workspaceId, input.workspaceId),
          eq(views.type, "bento")
        ),
      });
      const workspaceHome = bentoViews.find(
        (v) => homeScope(v.metadata) === "workspace"
      );
      return { view: workspaceHome ?? null };
    }),

  /**
   * Resolve the canonical SCOPED SURFACE for a lens (workspace / project /
   * session), auto-creating it if it doesn't exist yet.
   *
   * A scoped surface is the ONE canonical whiteboard / home / bento per lens —
   * marked with `metadata.scopedSurface === true` and (for whiteboard/bento)
   * unique per (type, workspace_id, project_id) via 0166's partial unique index.
   * Ordinary user boards carry no marker and are unconstrained.
   *
   * Scoping (mirrors getHome): workspace access is gated via verifyPermission and
   * the query is filtered on `workspace_id` so cross-workspace isolation holds.
   * `project_id` is filtered as a direct column; session is ephemeral and lives in
   * `metadata.sessionId` (no column).
   *
   * FIXES the bug where a whiteboard showed nothing under a project lens: the
   * caller now resolves/creates a project-scoped board instead of dereferencing a
   * workspace-only id that doesn't exist for that lens.
   */
  resolveScopedSurface: protectedProcedure
    .input(
      z.object({
        type: z.string().min(1),
        workspaceId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        sessionId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = input.workspaceId ?? null;
      const projectId = input.projectId ?? null;
      const sessionId = input.sessionId ?? null;

      // Access gate — same workspace check getHome uses, so cross-workspace
      // isolation holds. Pod-wide (no workspace) surfaces are user-owned.
      if (workspaceId) {
        const permResult = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: workspaceId },
          requiredPermission: "read",
        });
        if (!permResult.allowed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: permResult.reason ?? "Insufficient permissions",
          });
      }

      const isScopedSurface = (m: unknown) =>
        (m as Record<string, unknown> | null)?.scopedSurface === true;
      const metaSessionId = (m: unknown) =>
        (m as Record<string, unknown> | null)?.sessionId ?? null;

      // Scope the query on the access columns (workspace_id via the lens floor,
      // project_id direct) so a forged scope can never reach another workspace's
      // surface. Held in a const so the post-conflict re-read below uses the
      // EXACT same predicate as the initial find.
      const scopeWhere = and(
        eq(views.type, input.type),
        workspaceId
          ? and(
              eq(views.workspaceId, workspaceId),
              viewLensWhere(ctx.userId, workspaceId)
            )
          : and(isNull(views.workspaceId), eq(views.userId, ctx.userId)),
        projectId ? eq(views.projectId, projectId) : isNull(views.projectId)
      );

      // Find the marked canonical surface for this scope (session lives in
      // metadata, not a column, so it's filtered in JS).
      const findCanonicalSurface = async () => {
        const candidates = await db.query.views.findMany({ where: scopeWhere });
        return (
          candidates.find(
            (v) =>
              isScopedSurface(v.metadata) &&
              metaSessionId(v.metadata) === sessionId
          ) ?? null
        );
      };

      const existing = await findCanonicalSurface();
      if (existing) return { view: existing, status: "resolved" as const };

      // None found — CREATE the canonical surface for this scope.
      const category = getViewCategory(input.type);
      const viewId = randomUUID();

      // Canvas surfaces (whiteboard, mindmap) need a document for Yjs + MinIO +
      // versioning; a yjsRoomId is derived from it. Structured/bento surfaces
      // store config directly in views.config.
      let docId: string | null = null;
      if (category === "canvas") {
        const contentStr = JSON.stringify({});
        const contentBuffer = Buffer.from(contentStr, "utf-8");
        const storageKey = storage.buildPath(
          ctx.userId,
          input.type,
          viewId,
          "json"
        );
        const uploadResult = await storage.upload(storageKey, contentBuffer, {
          contentType: "application/json",
        });

        docId = randomUUID();
        const versionId = randomUUID();
        const snapshot = await uploadDocumentVersionSnapshot({
          userId: ctx.userId,
          documentId: docId,
          versionId,
          documentType: input.type,
          mimeType: "application/json",
          content: contentStr,
        });

        const [doc] = await db
          .insert(documents)
          .values({
            id: docId,
            userId: ctx.userId,
            workspaceId: workspaceId ?? undefined,
            type: input.type,
            title: input.type,
            storageUrl: uploadResult.url,
            storageKey: uploadResult.path,
            size: uploadResult.size,
            mimeType: "application/json",
            currentVersion: 1,
            lastSavedVersion: 1,
          })
          .returning();

        await db.insert(documentVersions).values({
          id: versionId,
          documentId: doc.id,
          version: 1,
          ...storedVersionValues(snapshot),
          author: "user",
          authorId: ctx.userId,
          message: "Initial version",
        });
      }

      const yjsRoomId = docId ? `whiteboard-${docId}` : undefined;

      const dbInstance = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const viewRepo = new ViewRepository(dbInstance, eventRepo);

      try {
        const createdView = await viewRepo.create(
          {
            id: viewId,
            type: input.type,
            name: input.type,
            documentId: docId,
            yjsRoomId,
            workspaceId,
            projectId,
            userId: ctx.userId,
            config: {},
            metadata: {
              scopedSurface: true,
              createdBy: ctx.userId,
              ...(sessionId ? { sessionId } : {}),
            },
          },
          ctx.userId
        );

        return { view: createdView, status: "created" as const };
      } catch (err) {
        // Two concurrent resolvers can both pass the find above and race the
        // insert; `views_scoped_surface_uniq_idx` guarantees only one wins.
        // The loser must CONVERGE on the winner's board, not surface a raw
        // unique-violation (same 23505 pattern as relations.ts).
        const pgCode =
          (err as { code?: string })?.code ??
          (err as { cause?: { code?: string } })?.cause?.code;
        if (pgCode !== "23505") throw err;

        // Best-effort: reap the loser's orphaned canvas document + version so
        // the race leaves no stray rows (storage object is left; harmless).
        // Log reap failures — a swallowed delete leaks an empty doc row with
        // zero observability otherwise.
        if (docId) {
          await db
            .delete(documentVersions)
            .where(eq(documentVersions.documentId, docId))
            .catch((reapErr: unknown) =>
              logger.warn(
                { err: reapErr, docId },
                "resolveScopedSurface: failed to reap orphan documentVersions"
              )
            );
          await db
            .delete(documents)
            .where(eq(documents.id, docId))
            .catch((reapErr: unknown) =>
              logger.warn(
                { err: reapErr, docId },
                "resolveScopedSurface: failed to reap orphan document"
              )
            );
        }

        const winner = await findCanonicalSurface();
        if (winner) return { view: winner, status: "resolved" as const };
        // The winner exists (the index rejected us) but is invisible to THIS
        // caller's find predicate (different userId on a multi-user pod, or a
        // different metadata.sessionId). Surface a clean conflict instead of
        // leaking the raw driver 23505 across the tRPC boundary. The underlying
        // shared-canonical-board semantics are a flagged product decision.
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "The canonical surface for this scope already exists but is not visible to you.",
        });
      }
    }),

  /**
   * Get view with content
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }

      if (!view.workspaceId && view.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Insufficient permissions",
        });
      }
      // Check access
      if (view.workspaceId) {
        const permResult = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: view.workspaceId },
          requiredPermission: "read", // or 'read' for requireViewer
        });
        if (!permResult.allowed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: permResult.reason || "Insufficient permissions",
          });
      }

      // Load content: whiteboards from MinIO (canonical), others from document_versions
      let content = {};
      if (view.documentId) {
        const doc = await db.query.documents.findFirst({
          where: eq(documents.id, view.documentId),
        });

        if (doc?.storageKey && view.type === "whiteboard") {
          // Whiteboard: MinIO is canonical source (Yjs writeState saves here)
          try {
            const buffer = await storage.downloadBuffer(doc.storageKey);
            content = JSON.parse(buffer.toString("utf-8"));
          } catch {
            content = {};
          }
        } else {
          // Other view types: load from document_versions
          const latestVersion = await db.query.documentVersions.findFirst({
            where: eq(documentVersions.documentId, view.documentId),
            orderBy: [desc(documentVersions.version)],
          });
          if (latestVersion) {
            try {
              content = JSON.parse(latestVersion.content);
            } catch {
              content = {};
            }
          }
        }
      }

      return { view, content };
    }),

  /**
   * Execute view query and return entities
   */
  execute: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        projectId: z.string().uuid().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }
      if (!view.workspaceId && view.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Insufficient permissions",
        });
      }
      // Check access
      if (view.workspaceId) {
        const permResult = await verifyPermission({
          db,
          userId: ctx.userId,
          workspace: { id: view.workspaceId },
          requiredPermission: "read", // or 'read' for requireViewer
        });
        if (!permResult.allowed)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: permResult.reason || "Insufficient permissions",
          });
      }

      const category = getViewCategory(view.type);

      // Canvas views: Return document content
      if (category === "canvas") {
        let content = {};
        if (view.documentId) {
          const latestVersion = await db.query.documentVersions.findFirst({
            where: eq(documentVersions.documentId, view.documentId),
            orderBy: [desc(documentVersions.version)],
          });
          if (latestVersion) {
            try {
              content = JSON.parse(latestVersion.content);
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (_e) {
              content = {};
            }
          }
        }

        return { view, content, entities: [], relations: [] };
      }

      // Structured views: Execute query from new query structure
      if (!view.scopeProfileIds || view.scopeProfileIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "View must have scopeProfileIds. Please recreate the view with profile scope.",
        });
      }

      // NEW: Use consolidated query structure
      const query = (view.query as EntityQuery) || {};
      const {
        filters = [],
        sorts = [],
        search,
        limit = 100,
        offset = 0,
      } = query;

      const conditions: any[] = [];

      const lensWorkspaceId = view.workspaceId ?? null;
      const facetVisibilityScope = await resolveFacetVisibilityScope(
        ctx.userId,
        lensWorkspaceId
      );
      // includePodWide MUST be true: pod-scoped entities (person/company and any
      // profile whose entityScope is 'pod') live with workspaceId IS NULL and are
      // visible in EVERY workspace. A workspace-scoped view narrows to its own
      // workspace AND those pod-wide rows (owner floor applies); the view's
      // kind/facet scopeCondition below narrows further. Hardcoding false dropped
      // every pod-wide person/company from every workspace view post-cutover.
      conditions.push(
        lensWorkspaceId
          ? entityLensWhereForViews(ctx.userId, lensWorkspaceId, true)
          : entityLensWhereForViews(ctx.userId, null, true)
      );

      // Project lens — narrow to a single project when set (mirrors entities.list pattern)
      if (input.projectId) {
        conditions.push(projectLensWhere(entities.id, input.projectId));
      }

      // Filter by scope profiles — polymorphic (Kind + Facets). A scope id can
      // name either a primary `kind` (match entities.profileId) or an
      // attachable `role`/facet (match via facetRoleExists). `convertToFacet`
      // flips profile_kind in place, so the same stored scopeProfileIds must
      // resolve to the same entities before and after conversion — hence the
      // per-id kind lookup + polymorphic helper rather than a blanket
      // inArray(entities.profileId, …). The facet branch is lensed by the
      // view's own owner (ctx.userId) + workspace (lensWorkspaceId).
      if (view.scopeProfileIds && view.scopeProfileIds.length > 0) {
        const scopeProfiles = await db.query.profiles.findMany({
          where: inArray(profiles.id, view.scopeProfileIds),
          columns: { id: true, profileKind: true },
        });
        const scopeCondition = profileScopeConditions(
          db,
          scopeProfiles,
          facetVisibilityScope
        );
        // All scope ids resolved to nothing (deleted profiles) → match no rows
        // rather than leaving the scope unfiltered.
        conditions.push(scopeCondition ?? pgSql`false`);
      }

      // Pre-resolve property definitions (avoid N+1), scoped to the
      // calling workspace's lens so other workspaces' overlays don't leak
      // into this view's compiled filters / column defaults.
      const dbInstance = await getDb();
      const propertyMerging = new PropertyMergingService(dbInstance);
      const mergedProperties =
        await propertyMerging.mergePropertiesFromProfiles(
          view.scopeProfileIds,
          dbInstance,
          lensWorkspaceId
        );

      // Build property metadata map (def IDs + indexed flag) for the
      // filter compiler — one merge, no double work in compileFilter.
      const propertyMetaMap = new Map<
        string,
        { propertyDefIds: string[]; indexed: boolean }
      >();
      for (const [slug, prop] of mergedProperties) {
        propertyMetaMap.set(slug, {
          propertyDefIds: prop.propertyDefIds,
          indexed: prop.indexed,
        });
      }

      // Apply custom filters (using ViewFilterCompiler with multi-profile support)
      if (filters && filters.length > 0) {
        const filterCompiler = new ViewFilterCompiler(dbInstance);
        try {
          const compiledFilters = await filterCompiler.compileFilters(
            filters as EntityFilter[],
            view.scopeProfileIds,
            propertyMetaMap,
            ctx.workspaceId
          );

          if (compiledFilters) {
            conditions.push(compiledFilters);
          }
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error instanceof Error ? error.message : "Invalid filter",
            cause: error,
          });
        }
      }

      // Apply full-text search
      if (search) {
        conditions.push(
          sql`(${entities.title} ILIKE ${`%${search}%`} OR ${entities.preview} ILIKE ${`%${search}%`})`
        );
      }

      // Build order by clauses with STRICT validation
      const orderByClause: any[] = [];
      if (sorts && sorts.length > 0) {
        for (const sort of sorts as SortRule[]) {
          // STRICT POLICY: Validate sort field
          if (sort.field.startsWith("properties.")) {
            const propertySlug = sort.field.split(".")[1];
            const property = mergedProperties.get(propertySlug);

            if (!property) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Property "${propertySlug}" not found in scope profiles`,
              });
            }

            // STRICT: Must be indexed
            if (!property.indexed) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Cannot sort by "${propertySlug}" - not indexed. Only indexed properties or core fields can be sorted.`,
              });
            }

            // STRICT: Must exist in all profiles
            if (property.profiles.length !== view.scopeProfileIds.length) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: `Cannot sort by "${propertySlug}" - property not present in all scope profiles. Sort requires property to exist in all profiles.`,
              });
            }
          }

          const sortClause = buildSortClause(sort);
          if (sortClause) {
            orderByClause.push(sortClause);
          }
        }
      }

      // Execute query
      let fetchedEntities = await db
        .select()
        .from(entities)
        .where(and(...conditions))
        .orderBy(
          ...(orderByClause.length > 0
            ? orderByClause
            : [desc(entities.createdAt)])
        )
        .limit(limit)
        .offset(offset);

      // Apply manual ordering if present (from metadata)
      const metadata = view.metadata as ViewMetadata | undefined;
      const entityOrders = metadata?.entityOrders;
      if (entityOrders && Object.keys(entityOrders).length > 0) {
        fetchedEntities = fetchedEntities.sort((a, b) => {
          const aOrder = entityOrders[a.id] ?? Infinity;
          const bOrder = entityOrders[b.id] ?? Infinity;
          return aOrder - bOrder;
        });
      }

      const facetSlugsByEntity = await loadFacetSlugsBatch(
        db,
        fetchedEntities.map((entity) => entity.id),
        facetVisibilityScope
      );
      const annotatedEntities = fetchedEntities.map((entity) => ({
        ...entity,
        facetSlugs: facetSlugsByEntity.get(entity.id) ?? [],
      }));

      // Get relations between entities
      const entityIds = fetchedEntities.map((e) => e.id);
      const fetchedRelations =
        entityIds.length > 0
          ? await db
              .select()
              .from(relations)
              .where(
                or(
                  inArray(relations.sourceEntityId, entityIds),
                  inArray(relations.targetEntityId, entityIds)
                )
              )
          : [];

      // Compute default columns from scope profiles
      const defaultColumnsService = new ViewDefaultColumnsService();
      const defaultColumns = defaultColumnsService.computeTableColumns(
        mergedProperties,
        view.scopeProfileIds.length
      );

      // Apply column overrides from config
      const config = (view.config as Record<string, unknown>) || {};
      const finalColumns = defaultColumnsService.applyColumnOverrides(
        defaultColumns,
        {
          hiddenColumns: config.hiddenColumns as string[] | undefined,
          visibleColumns: config.visibleColumns as string[] | undefined,
          columnOrder: config.columnOrder as string[] | undefined,
          columnWidths: config.columnWidths as
            Record<string, number> | undefined,
        }
      );

      return {
        view,
        query,
        config: view.config || {},
        entities: annotatedEntities,
        relations: fetchedRelations,
        columns: finalColumns,
      };
    }),

  /**
   * Save view content
   */
  save: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        content: z.any(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }
      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "write", // or 'read' for requireViewer
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });
      // Validate content structure
      const parseResult = ViewContentSchema.safeParse(input.content);
      if (!parseResult.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid view content structure",
          cause: parseResult.error,
        });
      }

      // Ensure content category matches view type
      const expectedCategory = getViewCategory(view.type);
      if (parseResult.data.category !== expectedCategory) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `View type '${view.type}' requires '${expectedCategory}' content, got '${parseResult.data.category}'`,
        });
      }

      // Save content to storage + create version snapshot
      if (view.documentId) {
        const doc = await db.query.documents.findFirst({
          where: eq(documents.id, view.documentId),
        });

        const contentStr = JSON.stringify(input.content);

        // Whiteboards: always push to MinIO (canonical source for Yjs)
        if (doc?.storageKey && view.type === "whiteboard") {
          await storage.upload(
            doc.storageKey,
            Buffer.from(contentStr, "utf-8"),
            { contentType: "application/json" }
          );
        }

        const newVersion = (doc?.currentVersion || 0) + 1;
        const versionId = randomUUID();
        const snapshot = await uploadDocumentVersionSnapshot({
          userId: ctx.userId,
          documentId: view.documentId,
          versionId,
          documentType: doc?.type ?? view.type,
          mimeType: doc?.mimeType || "application/json",
          content: contentStr,
        });

        await db.insert(documentVersions).values({
          id: versionId,
          documentId: view.documentId,
          version: newVersion,
          ...storedVersionValues(snapshot),
          author: "user",
          authorId: ctx.userId,
          message: "Manual save",
        });

        await db
          .update(documents)
          .set({
            currentVersion: newVersion,
            lastSavedVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, view.documentId));
      }

      // Update view metadata
      if (input.metadata) {
        await db
          .update(views)
          .set({
            metadata: input.metadata,
            updatedAt: new Date(),
          })
          .where(eq(views.id, input.id));
      }

      return { success: true };
    }),
  /**
   * Update view metadata (Synchronous: Direct DB update)
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        // NEW: Scope profiles
        scopeProfileIds: z.array(z.string().uuid()).optional(),
        scopeMode: z.enum(["explicit", "observed"]).optional(),
        // NEW: Consolidated query
        query: z
          .object({
            filters: z.array(z.any()).optional(),
            sorts: z.array(z.any()).optional(),
            search: z.string().optional(),
            limit: z.number().optional(),
            offset: z.number().optional(),
            groupBy: z.string().optional(),
          })
          .optional(),
        // NEW: Render config (overrides only)
        config: z.record(z.string(), z.any()).optional(),
        // NEW: Embedded view IDs (for composite views)
        embeddedViewIds: z.array(z.string().uuid()).optional(),
        // NEW: Schema snapshot
        schemaSnapshot: z.record(z.string(), z.any()).optional(),
        snapshotUpdatedAt: z.date().optional(),
        // Optional metadata patch — MERGED onto the existing view metadata
        // (e.g. { userAuthored: true } when the user first edits a generated
        // default bento). Never replaces the whole metadata object.
        metadata: z.record(z.string(), z.any()).optional(),
        // View type (for switching between types)
        // Uses ViewTypeEnum from @synap-core/types for single source of truth
        type: ViewTypeEnum.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }
      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }

      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "write",
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Workspace Home (metadata.homeScope === 'workspace') is editable only by admin/owner
      const metadata = (view.metadata as Record<string, unknown>) || {};
      if (metadata.homeScope === "workspace") {
        const member = await getWorkspaceMembership(
          db,
          view.workspaceId,
          ctx.userId
        );
        const role = member?.role;
        if (role !== "admin" && role !== "owner")
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace admins can edit the workspace Home",
          });
      }

      // Validate config against view type schema (use input.type or existing view.type)
      const viewType = input.type || view.type;
      if (input.config) {
        const validation = validateViewConfig(viewType, input.config);
        if (!validation.valid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid view config",
            cause: validation.errors,
          });
        }
        assertValidRendererRef(input.config);
      }

      // Direct DB update via ViewRepository
      const dbInstance = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const viewRepo = new ViewRepository(dbInstance, eventRepo);

      const updatedView = await viewRepo.update(
        input.id,
        {
          name: input.name,
          type: input.type,
          description: input.description,
          scopeProfileIds: input.scopeProfileIds,
          scopeMode: input.scopeMode,
          query: input.query as Record<string, unknown> | undefined,
          config: input.config as Record<string, unknown> | undefined,
          embeddedViewIds: input.embeddedViewIds,
          schemaSnapshot: input.schemaSnapshot as
            Record<string, unknown> | undefined,
          snapshotUpdatedAt: input.snapshotUpdatedAt,
          // Merge the metadata patch onto existing metadata (never replace).
          metadata: input.metadata
            ? { ...metadata, ...input.metadata }
            : undefined,
        },
        ctx.userId
      );

      // Audit log (fire-and-forget)
      auditLog({
        subjectType: "view",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: view.workspaceId,
        data: {
          id: input.id,
          name: input.name,
          type: input.type,
        },
      });

      // Side-effects (search indexing, webhooks — fire-and-forget)
      emitSideEffects({
        subjectType: "view",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: view.workspaceId,
        data: {
          id: input.id,
          name: input.name || view.name,
        },
      });

      return {
        status: "updated",
        message: "View updated",
        view: updatedView,
      };
    }),

  /**
   * Delete view (Synchronous: Direct DB delete)
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }
      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }

      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "write", // or 'read' for requireViewer
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Delete view via ViewRepository
      const dbInstance = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const viewRepo = new ViewRepository(dbInstance, eventRepo);

      await viewRepo.delete(input.id, ctx.userId);

      // Also delete the associated document
      if (view.documentId) {
        await db.delete(documents).where(eq(documents.id, view.documentId));
      }

      // Audit log (fire-and-forget)
      auditLog({
        subjectType: "view",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: view.workspaceId,
        data: { id: input.id },
      });

      // Side-effects (search de-index, webhooks — fire-and-forget)
      emitSideEffects({
        subjectType: "view",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: view.workspaceId,
        data: { id: input.id },
      });

      return { success: true, status: "deleted" };
    }),

  /**
   * Reorder entity in view (manual ordering)
   */
  reorderEntity: protectedProcedure
    .input(
      z.object({
        viewId: z.string().uuid(),
        entityId: z.string().uuid(),
        beforeEntityId: z.string().uuid().optional(),
        afterEntityId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.viewId),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }

      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }

      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "write", // or 'read' for requireViewer
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Get current entity orders
      const metadata = (view.metadata as ViewMetadata) || {};
      const entityOrders = metadata.entityOrders || {};

      // Calculate new order using fractional indexing
      let newOrder: number;

      if (input.beforeEntityId && input.afterEntityId) {
        const beforeOrder = entityOrders[input.beforeEntityId] ?? 0;
        const afterOrder = entityOrders[input.afterEntityId] ?? beforeOrder + 2;
        newOrder = (beforeOrder + afterOrder) / 2;
      } else if (input.beforeEntityId) {
        const beforeOrder = entityOrders[input.beforeEntityId] ?? 0;
        newOrder = beforeOrder + 1;
      } else if (input.afterEntityId) {
        const afterOrder = entityOrders[input.afterEntityId] ?? 1;
        newOrder = afterOrder / 2;
      } else {
        const maxOrder = Math.max(
          ...(Object.values(entityOrders) as number[]),
          0
        );
        newOrder = maxOrder + 1;
      }

      // Update entity order
      entityOrders[input.entityId] = newOrder;

      // Update view metadata
      await db
        .update(views)
        .set({
          metadata: {
            ...metadata,
            entityOrders,
          },
          updatedAt: new Date(),
        })
        .where(eq(views.id, input.viewId));

      return {
        success: true,
        newOrder,
      };
    }),

  /**
   * Get available columns for a view (from scope profiles)
   */
  getAvailableColumns: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const view = await db.query.views.findFirst({
        where: eq(views.id, input.id),
      });

      if (!view) {
        throw new TRPCError({ code: "NOT_FOUND", message: "View not found" });
      }

      if (!view.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "View must belong to a workspace",
        });
      }

      // Check access
      const permResult = await verifyPermission({
        db,
        userId: ctx.userId,
        workspace: { id: view.workspaceId },
        requiredPermission: "read",
      });
      if (!permResult.allowed)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: permResult.reason || "Insufficient permissions",
        });

      // Only structured views have columns
      if (view.category !== "structured") {
        return { columns: [] };
      }

      if (!view.scopeProfileIds || view.scopeProfileIds.length === 0) {
        return { columns: [] };
      }

      // Merge properties from scope profiles — through the calling
      // workspace's lens so default columns don't include another
      // workspace's overlay props.
      const dbInstance = await getDb();
      const propertyMerging = new PropertyMergingService(dbInstance);
      const mergedProperties =
        await propertyMerging.mergePropertiesFromProfiles(
          view.scopeProfileIds,
          dbInstance,
          ctx.workspaceId
        );

      // Compute default columns
      const defaultColumnsService = new ViewDefaultColumnsService();
      const columns = defaultColumnsService.computeTableColumns(
        mergedProperties,
        view.scopeProfileIds.length
      );

      return { columns };
    }),

  /**
   * Lazily create (or return existing) bento view for a profile.
   *
   * The viewId is stored in workspace.settings.profileBentoViewIds[profileSlug]
   * (not on the profile row) so system/shared profiles can have different bento
   * views per workspace. Uses mergeSettings for an atomic JSONB patch.
   */
  ensureProfileBento: workspaceProcedure
    .input(z.object({ profileSlug: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const dbConn = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;

      // 1. Check workspace settings for an existing bento view ID (O(1) lookup)
      const workspace = await dbConn.query.workspaces.findFirst({
        where: eq(workspaces.id, ctx.workspaceId),
      });
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      }

      const settings = (workspace.settings ?? {}) as Record<string, unknown>;
      const profileBentoViewIds = (settings.profileBentoViewIds ??
        {}) as Record<string, string>;
      const existingViewId = profileBentoViewIds[input.profileSlug];
      if (existingViewId) {
        return { viewId: existingViewId };
      }

      // 2. Find the profile
      const profileRepo = new ProfileRepository(dbConn);
      const profile = await profileRepo.getBySlugForWorkspace(
        input.profileSlug,
        ctx.workspaceId
      );
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile '${input.profileSlug}' not found`,
        });
      }

      // 3. Build default blocks and create bento view
      const color =
        ((profile.uiHints as Record<string, unknown>)?.color as
          string | undefined) ?? "#6366F1";
      const rawIcon = (profile.uiHints as Record<string, unknown>)?.icon as
        string | undefined;
      const icon = rawIcon
        ? rawIcon
            .split("-")
            .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
            .join("")
        : "Database";
      const slug = profile.slug;

      const blocks = [
        {
          id: `${slug}-header`,
          kind: "widget",
          widgetType: "section-header",
          pos: { x: 0, y: 0, w: 12, h: 2 },
          config: {
            title: profile.displayName,
            icon,
            profileSlug: slug,
            color,
          },
        },
        {
          id: `${slug}-count`,
          kind: "widget",
          widgetType: "stat-card",
          pos: { x: 0, y: 2, w: 3, h: 3 },
          config: {
            label: `Total ${profile.displayName}s`,
            aggregation: "count",
            profileSlug: slug,
            icon,
            color,
          },
        },
        {
          id: `${slug}-table`,
          kind: "widget",
          widgetType: "view-table",
          pos: { x: 0, y: 5, w: 12, h: 9 },
          config: { profileSlug: slug },
        },
      ];

      const viewRepo = new ViewRepository(dbConn, eventRepo);
      const newView = await viewRepo.create(
        {
          name: profile.displayName,
          type: "bento",
          scopeProfileIds: [profile.id],
          config: { layout: "bento", blocks },
          metadata: { isProfileBento: true, profileSlug: slug },
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        },
        ctx.userId
      );

      // 4. Atomically merge the new viewId into workspace settings
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);
      await workspaceRepo.mergeSettings(
        ctx.workspaceId,
        { profileBentoViewIds: { ...profileBentoViewIds, [slug]: newView.id } },
        ctx.userId
      );

      return { viewId: newView.id };
    }),
});

/**
 * Build a sort clause from a SortRule
 */
function buildSortClause(sort: SortRule): SQL | null {
  const { field, direction } = sort;
  const isPropertyField = field.startsWith("properties.");

  if (isPropertyField) {
    const propertyKey = field.split(".")[1];
    const propertiesCol = entities.properties; // Use properties instead of metadata

    // Sort by JSON field text value
    return direction === "asc"
      ? sql`${propertiesCol}->>${propertyKey} ASC`
      : sql`${propertiesCol}->>${propertyKey} DESC`;
  } else {
    const entityColumns = getTableColumns(entities);
    if (field in entityColumns) {
      const column = entityColumns[field as keyof typeof entityColumns];
      return direction === "asc" ? asc(column) : desc(column);
    }
    return null;
  }
}
