/**
 * Capture Router - Unified Capture Pipeline
 *
 * Three endpoints:
 * - thought:    Single-entity classify + create (legacy / SDK)
 * - structure:  Multi-entity extraction + dedup search (AI pipeline step 1)
 * - execute:    Batch entity + relation creation (AI pipeline step 2)
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, workspaceProcedure, podProcedure } from "../trpc.js";
import { requireUserId, requireWorkspaceId } from "../utils/user-scoped.js";
import { aiRateLimitMiddleware } from "../middleware/ai-rate-limit.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import {
  sql,
  eq,
  getDb,
  EventRepository,
  EntityRepository,
  RelationRepository,
  RelationDefRepository,
  ProfileResolutionService,
  PropertyDefRepository,
  EntityUpsertService,
  workspaces,
  workspaceMembers,
  type PropertyValueType,
  type IdentitySignal,
} from "@synap/database";
import { searchService } from "@synap/search";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";
import { markServiceCredentialError } from "../utils/credential-auto-repair.js";
import { emitSideEffects } from "@synap/events";
import { eventRepository } from "@synap/database";
import { randomUUID as _captureUUID } from "crypto";

const logger = createLogger({ module: "capture-router" });

// ── Default relation type for unknown slugs ────────────────────────────────

const FALLBACK_RELATION_TYPE = "relates_to";

// ── Schema-complete profile hints for the structuring LLM ──────────────────
// "Read before write": the one-shot /structure call has no tool loop, so the
// caller pre-reads each profile's real property schema and hands it to the model.
// Instead of a bare slug list ("status, dueDate, priority") we emit a TYPED hint
// ("status:enum(todo|in-progress|done|cancelled), dueDate:date, priority:enum(...)")
// so the model maps extracted values into the correct typed fields with valid
// enum values and link targets — not invented keys.

interface RawEffectiveProperty {
  slug: string;
  valueType?: string;
  required?: boolean;
  constraints?: { enum?: unknown[]; [k: string]: unknown } | null;
  targetProfileId?: string | null;
}

export interface AccessibleProfileLike {
  id?: string;
  slug: string;
  displayName?: string | null;
  uiHints?: Record<string, unknown> | null;
  effectiveProperties?: RawEffectiveProperty[];
}

function typedPropertyHint(
  prop: RawEffectiveProperty,
  slugByProfileId: Map<string, string>
): string {
  let type = prop.valueType || "string";
  const enumVals = prop.constraints?.enum;
  if (Array.isArray(enumVals) && enumVals.length) {
    type = `enum(${enumVals.join("|")})`;
  } else if (prop.targetProfileId) {
    const target = slugByProfileId.get(prop.targetProfileId);
    type = target ? `link->${target}` : "link";
  }
  return `${prop.slug}:${type}${prop.required ? "*" : ""}`;
}

export function buildAvailableProfiles(profiles: AccessibleProfileLike[]) {
  const slugByProfileId = new Map<string, string>();
  for (const p of profiles) if (p.id) slugByProfileId.set(p.id, p.slug);

  return profiles
    .filter((p) => !(p.uiHints as Record<string, unknown>)?.hideFromCreate)
    .map((p) => ({
      slug: p.slug,
      displayName: p.displayName || p.slug,
      description:
        ((p.uiHints as Record<string, unknown>)?.description as string) ||
        undefined,
      propertyHints:
        p.effectiveProperties
          ?.map((prop) => typedPropertyHint(prop, slugByProfileId))
          .join(", ") || undefined,
    }));
}

export const captureRouter = router({
  // ── thought (legacy single-entity) ─────────────────────────────────────

  /**
   * Capture a raw thought — single entity classify + create.
   * Kept for backward compat with @synap/client SDK.
   */
  thought: workspaceProcedure
    .use(aiRateLimitMiddleware)
    .input(
      z.object({
        content: z.string().min(1).describe("Raw thought content"),
        url: z.string().url().optional().describe("Optional source URL"),
        context: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional context metadata"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = requireWorkspaceId(ctx.workspaceId);

      logger.debug(
        { userId, contentLength: input.content.length },
        "Processing thought capture"
      );

      // Step 1: Classify via Intelligence Service
      let profileSlug = "note";
      let title = input.content.slice(0, 80).trim();
      let properties: Record<string, unknown> = {};
      let mode: "ai" | "fallback" = "fallback";

      try {
        const profileDb = await getDb();
        const profileService = new ProfileResolutionService(profileDb);
        const accessibleProfiles = await profileService.getAccessibleProfiles(
          userId,
          workspaceId
        );
        const availableProfiles = buildAvailableProfiles(
          accessibleProfiles as unknown as AccessibleProfileLike[]
        );

        const { client } = await resolveIntelligenceService({
          userId,
          workspaceId: workspaceId,
          capability: "default",
        });
        const result = await client.structure({
          text: input.content,
          url: input.url,
          hints: { availableProfiles },
        });
        const entity = result?.entities?.[0];
        if (entity) {
          profileSlug = entity.profileSlug;
          title = entity.title || title;
          properties = entity.properties ?? {};
          mode = "ai";
          logger.debug(
            { userId, profileSlug, confidence: entity.confidence },
            "Thought classified by IS"
          );
        }
      } catch (err) {
        logger.warn(
          { err, userId },
          "IS classification failed, falling back to note"
        );
        markServiceCredentialError();
      }

      // Merge optional URL into properties for bookmark-family profiles
      if (input.url) {
        properties = { url: input.url, ...properties };
      }

      // Step 2: Create entity
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);

      let entity: Awaited<ReturnType<typeof entityRepo.create>>;
      try {
        entity = await entityRepo.create(
          {
            workspaceId: workspaceId,
            userId,
            title,
            properties,
            profileSlug,
          },
          userId
        );
      } catch (err) {
        // Profile validation failed — retry as note
        logger.warn(
          { err, userId, profileSlug },
          "Entity creation failed, retrying as note"
        );
        entity = await entityRepo.create(
          {
            workspaceId: workspaceId,
            userId,
            title,
            properties: input.url ? { url: input.url } : {},
            profileSlug: "note",
          },
          userId
        );
        profileSlug = "note";
        mode = "fallback";
      }

      logger.info(
        { userId, entityId: entity.id, profileSlug, mode },
        "Thought captured and entity created"
      );

      return {
        success: true,
        entityId: entity.id,
        profileSlug,
        title,
        mode,
      };
    }),

  // ── structure (multi-entity extraction + dedup) ────────────────────────

  /**
   * Extract multiple entities + relations from raw text.
   * Calls IS /api/structure, then searches Typesense for dedup candidates.
   */
  structure: podProcedure
    .use(aiRateLimitMiddleware)
    .input(
      z.object({
        text: z.string().min(1).max(8000),
        url: z.string().url().optional(),
        html: z.string().max(50_000).optional(),
        context: z.string().optional(),
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
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = ctx.workspaceId; // string | null — pod-wide allowed

      logger.debug(
        { userId, contentLength: input.text.length },
        "Structure capture: calling IS"
      );

      // 1. Fetch accessible profiles for IS hints.
      // When workspaceId is null (hydration onboarding), pass empty string so
      // the repo query falls back to SYSTEM + USER-scope profiles only — exactly
      // what a workspace-less user should see.
      const database = await getDb();
      const profileService = new ProfileResolutionService(database);
      const accessibleProfiles = await profileService.getAccessibleProfiles(
        userId,
        workspaceId ?? ""
      );
      const availableProfiles = buildAvailableProfiles(
        accessibleProfiles as unknown as AccessibleProfileLike[]
      );

      // 2. Fetch user's workspaces for routing hints (max 5, most recent)
      const userWorkspaceRows = await database
        .select({
          id: workspaces.id,
          name: workspaces.name,
          description: workspaces.description,
        })
        .from(workspaces)
        .innerJoin(
          workspaceMembers,
          eq(workspaceMembers.workspaceId, workspaces.id)
        )
        .where(eq(workspaceMembers.userId, userId))
        .limit(5);
      const availableWorkspaces = userWorkspaceRows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description ?? undefined,
      }));

      // 3. Call IS /api/structure
      const { client } = await resolveIntelligenceService({
        userId,
        workspaceId: workspaceId ?? undefined,
        capability: "default",
      });

      // Gather existing-entity names UP FRONT so the LLM can link/dedup instead
      // of blindly creating duplicates. Search the input text against the
      // entities collection; cap + best-effort (never fail the capture on this).
      let existingEntityNames: string[] = [];
      try {
        const existing = await searchService.searchCollection(
          "entities",
          input.text.slice(0, 200),
          { userId, workspaceId: workspaceId ?? undefined, limit: 30 }
        );
        existingEntityNames = Array.from(
          new Set(
            existing.results
              .map((r) => r.document?.title as string | undefined)
              .filter((t): t is string => Boolean(t && t.trim()))
          )
        );
      } catch {
        // Typesense unavailable — proceed without dedup hints.
        existingEntityNames = [];
      }

      const structureResult = await client.structure({
        text: input.text,
        url: input.url,
        html: input.html,
        context: input.context,
        hints: {
          availableProfiles,
          availableWorkspaces,
          existingEntityNames,
          previousEntities: input.previousEntities,
        },
      });

      if (!structureResult) {
        // IS unavailable — mark credentials and return fallback
        // Frontend will detect this via /api/provision/status and trigger re-provisioning via CP
        logger.warn(
          { userId },
          "IS structure returned null — marking service as credential_error"
        );
        markServiceCredentialError();

        return {
          proposals: [
            {
              tempId: "t1",
              profileSlug: "note",
              title: input.text.slice(0, 80).trim(),
              description: input.text.length > 80 ? input.text : undefined,
              properties: { content: input.text },
              confidence: 0.3,
            },
          ],
          relations: [] as Array<{
            sourceTempId: string;
            targetTempId: string;
            relationType: string;
          }>,
          followUp: null as string | null,
          targetWorkspaceId: null as string | null,
          dedupCandidates: {} as Record<
            string,
            Array<{
              entityId: string;
              title: string;
              profileSlug: string;
              score: number;
            }>
          >,
        };
      }

      // 2. If followUp, pass through immediately (no dedup yet)
      if (structureResult.followUp) {
        return {
          proposals: structureResult.entities,
          relations: structureResult.relations,
          followUp: structureResult.followUp,
          targetWorkspaceId: structureResult.targetWorkspaceId ?? null,
          dedupCandidates: {} as Record<
            string,
            Array<{
              entityId: string;
              title: string;
              profileSlug: string;
              score: number;
            }>
          >,
        };
      }

      // 3. Dedup: for each entity, search for existing matches
      const dedupCandidates: Record<
        string,
        Array<{
          entityId: string;
          title: string;
          profileSlug: string;
          score: number;
        }>
      > = {};

      try {
        for (const entity of structureResult.entities) {
          if (!entity.title) continue;

          try {
            const searchResult = await searchService.searchCollection(
              "entities",
              entity.title,
              { userId, workspaceId: workspaceId ?? undefined, limit: 3 }
            );

            // Typesense textMatch is a large integer; normalize to 0-1
            const maxScore = searchResult.results.reduce(
              (max, r) => Math.max(max, r.textMatch),
              1
            );
            dedupCandidates[entity.tempId] = searchResult.results
              .filter((r) => r.document?.id !== undefined)
              .map((r) => ({
                entityId: r.document.id as string,
                title: (r.document.title as string) || "",
                profileSlug: (r.document.entityType as string) || "note",
                score: r.textMatch / maxScore,
              }));
          } catch {
            // Search failed for this entity — skip dedup
            dedupCandidates[entity.tempId] = [];
          }
        }
      } catch {
        // Typesense not available — skip all dedup
        logger.warn("Typesense unavailable, skipping dedup search");
      }

      logger.info(
        {
          userId,
          entityCount: structureResult.entities.length,
          relationCount: structureResult.relations.length,
        },
        "Structure capture: proposals ready"
      );

      return {
        proposals: structureResult.entities,
        relations: structureResult.relations,
        followUp: null as string | null,
        targetWorkspaceId: structureResult.targetWorkspaceId ?? null,
        dedupCandidates,
      };
    }),

  // ── analyzeBulkMapping (AI-driven CSV mapping plan) ─────────────────────
  //
  // Given the headers + a few sample rows of a tabular bulk input (CSV, paste,
  // spreadsheet) plus the workspace's available profiles and relations,
  // returns a structured plan describing how each column should be routed to
  // entity types, properties, and relation metadata.
  //
  // Read-only: callers show the plan to the user, who confirms before any
  // import happens. Falls back gracefully — returns null if IS is unavailable.
  analyzeBulkMapping: podProcedure
    .use(aiRateLimitMiddleware)
    .input(
      z.object({
        headers: z.array(z.string()).min(1).max(200),
        sampleRows: z.array(z.array(z.string())).min(1).max(20),
        intent: z.string().min(1).max(500),
        availableProfiles: z
          .array(
            z.object({
              slug: z.string(),
              displayName: z.string(),
              description: z.string().optional(),
              propertyHints: z.string().optional(),
            })
          )
          .min(1),
        availableRelations: z.array(z.string()).optional(),
        contextHint: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = ctx.workspaceId; // string | null — pod-wide allowed

      const { client } = await resolveIntelligenceService({
        userId,
        workspaceId: workspaceId ?? undefined,
        capability: "default",
      });

      const plan = await client.analyzeBulkMapping(input);

      if (!plan) {
        logger.warn(
          { userId, headerCount: input.headers.length },
          "analyzeBulkMapping returned null — IS unreachable or errored (check IS logs for OPENROUTER_API_KEY / model availability)"
        );
        markServiceCredentialError();
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "AI analysis unavailable — intelligence service did not return a plan. Check IS logs.",
        });
      }

      return plan;
    }),

  // ── execute (batch entity + relation creation) ─────────────────────────

  /**
   * Batch-create entities and relations from confirmed proposals.
   * Maps tempIds to real entity IDs, creates relations between them.
   */
  execute: podProcedure
    .input(
      z.object({
        entities: z.array(
          z.object({
            tempId: z.string(),
            profileSlug: z.string(),
            title: z.string(),
            description: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            /** Link to existing entity instead of creating */
            existingEntityId: z.string().uuid().optional(),
          })
        ),
        relations: z.array(
          z.object({
            sourceTempId: z.string(),
            targetTempId: z.string(),
            relationType: z.string(),
          })
        ),
        /** User-selected workspace override — takes precedence over session default. */
        targetWorkspaceId: z.string().uuid().nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // User-selected override wins over session workspace.
      const workspaceId = input.targetWorkspaceId ?? ctx.workspaceId;

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);
      const relationRepo = new RelationRepository(database, eventRepo);

      // 1. Create or link entities in parallel, building tempId → realId map
      const createResults = await Promise.allSettled(
        input.entities.map(async (entity) => {
          if (entity.existingEntityId) {
            return {
              tempId: entity.tempId,
              entityId: entity.existingEntityId,
              profileSlug: entity.profileSlug,
              linked: true,
            };
          }
          try {
            const newEntity = await entityRepo.create(
              {
                workspaceId,
                userId,
                title: entity.title,
                preview: entity.description,
                properties: entity.properties ?? {},
                profileSlug: entity.profileSlug,
              },
              userId
            );
            return {
              tempId: entity.tempId,
              entityId: newEntity.id,
              profileSlug: entity.profileSlug,
              linked: false,
            };
          } catch (err) {
            // Retry as note on profile validation failure
            logger.warn(
              { err, tempId: entity.tempId, profileSlug: entity.profileSlug },
              "Entity creation failed, retrying as note"
            );
            const fallback = await entityRepo.create(
              {
                workspaceId,
                userId,
                title: entity.title,
                preview: entity.description,
                properties: {},
                profileSlug: "note",
              },
              userId
            );
            return {
              tempId: entity.tempId,
              entityId: fallback.id,
              profileSlug: "note",
              linked: false,
            };
          }
        })
      );

      // Build tempToReal map from settled results
      const tempToReal: Record<string, string> = {};
      const created: Array<{
        tempId: string;
        entityId: string;
        profileSlug: string;
        linked: boolean;
      }> = [];
      for (const result of createResults) {
        if (result.status === "fulfilled") {
          tempToReal[result.value.tempId] = result.value.entityId;
          created.push(result.value);
        }
      }

      // 2. Create relations using resolved IDs
      const createdRelations: Array<{
        sourceEntityId: string;
        targetEntityId: string;
        relationType: string;
      }> = [];

      // Prefetch all valid relation type slugs for this workspace (avoids N+1).
      // Workspace-less callers (hydration) just get the fallback — custom
      // relation types are a workspace-scoped concept.
      const relDefRepo = new RelationDefRepository(database);
      let validRelationSlugs: Set<string>;
      if (workspaceId) {
        try {
          const allDefs = await relDefRepo.list(workspaceId);
          validRelationSlugs = new Set(allDefs.map((d) => d.slug));
        } catch {
          validRelationSlugs = new Set([FALLBACK_RELATION_TYPE]);
        }
      } else {
        validRelationSlugs = new Set([FALLBACK_RELATION_TYPE]);
      }

      for (const rel of input.relations) {
        const sourceId = tempToReal[rel.sourceTempId];
        const targetId = tempToReal[rel.targetTempId];
        if (!sourceId || !targetId || sourceId === targetId) continue;

        // Validate relation type — fall back to generic "relates_to"
        const relationType = validRelationSlugs.has(rel.relationType)
          ? rel.relationType
          : FALLBACK_RELATION_TYPE;

        try {
          await relationRepo.create(
            {
              id: randomUUID(),
              sourceEntityId: sourceId,
              targetEntityId: targetId,
              type: relationType,
              workspaceId,
              userId,
            },
            userId
          );
          createdRelations.push({
            sourceEntityId: sourceId,
            targetEntityId: targetId,
            relationType,
          });
        } catch (err) {
          logger.warn(
            {
              err,
              sourceId,
              targetId,
              relationType,
            },
            "Relation creation failed, skipping"
          );
        }
      }

      logger.info(
        {
          userId,
          entitiesCreated: created.filter((c) => !c.linked).length,
          entitiesLinked: created.filter((c) => c.linked).length,
          relationsCreated: createdRelations.length,
        },
        "Capture execute completed"
      );

      // Emit capture.complete event — enables automation triggers + event log audit trail
      if (created.length > 0) {
        const captureEventId = _captureUUID();
        const entityIds = created.map((c) => c.entityId);
        const profileSlugs = [...new Set(created.map((c) => c.profileSlug))];
        const eventData = {
          workspaceId: workspaceId ?? undefined,
          entityIds,
          profileSlugs,
          entityCount: created.filter((c) => !c.linked).length,
          linkedCount: created.filter((c) => c.linked).length,
        };

        // Per-entity side-effects: search indexing, embeddings, webhooks.
        // source='capture' in data so event consumers can distinguish provenance.
        for (const c of created) {
          if (!c.linked) {
            emitSideEffects({
              subjectType: "entity",
              action: "create",
              subjectId: c.entityId,
              userId,
              workspaceId: workspaceId ?? undefined,
              data: { source: "capture", profileSlug: c.profileSlug },
            }).catch(() => {});
          }
        }

        // pg-boss side-effects → automation-trigger-matcher receives capture.complete.completed
        emitSideEffects({
          subjectType: "capture",
          action: "complete",
          subjectId: captureEventId,
          userId,
          workspaceId: workspaceId ?? undefined,
          data: eventData,
        }).catch(() => {}); // fire-and-forget

        // Event log → audit trail + sync replication
        eventRepository
          .append({
            id: captureEventId,
            version: "v1",
            type: "capture.complete.completed",
            subjectType: "capture",
            data: eventData,
            userId,
            source: "api",
            timestamp: new Date(),
          })
          .catch(() => {}); // non-blocking
      }

      return { created, relations: createdRelations };
    }),

  // ── executeWithSchema (batch property_def create + entity upsert) ──────
  //
  // Three-layer import pipeline step: parser proposes a schema (properties)
  // and a batch of entities; this endpoint creates the missing PropertyDefs
  // first, then upserts entities through EntityUpsertService (cross-source
  // dedup via identity_signals), then wires relations.
  //
  // Unlike `execute`, entities here go through EntityUpsertService so that
  // re-imports from the same or a different source collapse onto one entity.
  // Property defs can be remapped (`remapTo`) when the parser suggests a
  // new slug that a workspace already has a canonical name for.
  executeWithSchema: podProcedure
    .input(
      z.object({
        properties: z.array(
          z.object({
            profileSlug: z.string(),
            slug: z.string(),
            displayName: z.string().optional(),
            valueType: z.enum([
              "string",
              "number",
              "boolean",
              "date",
              "entity_id",
              "array",
              "object",
              "secret",
            ]),
            constraints: z.record(z.string(), z.unknown()).optional(),
            /** When present, remap incoming property to this existing slug instead of creating a new def. */
            remapTo: z.string().optional(),
          })
        ),
        entities: z.array(
          z.object({
            tempId: z.string(),
            profileSlug: z.string(),
            title: z.string(),
            description: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            /** Provenance from parser — used for dedup + audit trail. */
            source: z.string().optional(),
            externalId: z.string().optional(),
            signals: z
              .array(
                z.object({
                  type: z.enum([
                    "email",
                    "phone",
                    "telegram_phone",
                    "linkedin_url",
                    "github_username",
                    "twitter_handle",
                    "website",
                  ]),
                  value: z.string(),
                })
              )
              .optional(),
            existingEntityId: z.string().uuid().optional(),
          })
        ),
        relations: z.array(
          z.object({
            sourceTempId: z.string(),
            targetTempId: z.string(),
            relationType: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // workspaceId is optional — pod-wide profiles accept null, workspace
      // scoped profiles will throw inside EntityRepository.create.
      const workspaceId = ctx.workspaceId;

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const profileService = new ProfileResolutionService(database);
      const propDefRepo = new PropertyDefRepository(database);
      const upsertService = new EntityUpsertService(database, eventRepo);
      const relationRepo = new RelationRepository(database, eventRepo);

      // ── Phase 1: property defs ────────────────────────────────────────────
      // remap[profileSlug][fromSlug] = toSlug — applied to entity properties
      const remap: Record<string, Record<string, string>> = {};
      let propertiesCreated = 0;
      let propertiesRemapped = 0;
      const propertiesFailed: Array<{
        slug: string;
        profileSlug: string;
        reason: string;
      }> = [];

      // Cache profileSlug → profileId lookups to avoid repeated resolution
      const profileIdCache = new Map<string, string | null>();
      const resolveProfileId = async (slug: string): Promise<string | null> => {
        if (profileIdCache.has(slug)) return profileIdCache.get(slug) ?? null;
        const profile = await profileService.resolveProfile(
          slug,
          userId,
          workspaceId
        );
        const id = profile?.id ?? null;
        profileIdCache.set(slug, id);
        return id;
      };

      for (const prop of input.properties) {
        if (prop.remapTo) {
          remap[prop.profileSlug] ??= {};
          remap[prop.profileSlug][prop.slug] = prop.remapTo;
          propertiesRemapped++;
          continue;
        }

        try {
          const profileId = await resolveProfileId(prop.profileSlug);
          if (!profileId) {
            propertiesFailed.push({
              slug: prop.slug,
              profileSlug: prop.profileSlug,
              reason: `profile not found: ${prop.profileSlug}`,
            });
            continue;
          }

          const uiHints: Record<string, unknown> = {};
          if (prop.displayName) uiHints.displayName = prop.displayName;

          await propDefRepo.create({
            slug: prop.slug,
            valueType: prop.valueType as PropertyValueType,
            constraints: prop.constraints,
            uiHints: Object.keys(uiHints).length > 0 ? uiHints : undefined,
            profileId,
            workspaceId,
          });
          propertiesCreated++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, slug: prop.slug, profileSlug: prop.profileSlug },
            "Property def creation failed, continuing batch"
          );
          propertiesFailed.push({
            slug: prop.slug,
            profileSlug: prop.profileSlug,
            reason,
          });
        }
      }

      // ── Phase 2: entities (through EntityUpsertService) ───────────────────
      const tempToReal: Record<string, string> = {};
      const created: Array<{
        tempId: string;
        entityId: string;
        profileSlug: string;
        action: "created" | "updated" | "matched" | "linked";
      }> = [];

      for (const entity of input.entities) {
        if (entity.existingEntityId) {
          tempToReal[entity.tempId] = entity.existingEntityId;
          created.push({
            tempId: entity.tempId,
            entityId: entity.existingEntityId,
            profileSlug: entity.profileSlug,
            action: "linked",
          });
          continue;
        }

        // Apply remap to incoming property keys.
        const profileRemap = remap[entity.profileSlug];
        const rawProps = entity.properties ?? {};
        const properties: Record<string, unknown> = profileRemap
          ? Object.fromEntries(
              Object.entries(rawProps).map(([k, v]) => [
                profileRemap[k] ?? k,
                v,
              ])
            )
          : rawProps;

        const source = entity.source ?? "import";
        const externalId = entity.externalId ?? entity.tempId;
        const signals: IdentitySignal[] = entity.signals ?? [];

        try {
          // workspaceId may be null — pod-wide profiles resolve entityScope
          // inside EntityRepository and may still persist with workspace_id=null.
          const result = await upsertService.upsert({
            profileSlug: entity.profileSlug,
            title: entity.title,
            properties,
            source,
            externalId,
            signals,
            workspaceId,
            userId,
          });
          tempToReal[entity.tempId] = result.entity.id;
          created.push({
            tempId: entity.tempId,
            entityId: result.entity.id,
            profileSlug: entity.profileSlug,
            action: result.action,
          });
        } catch (err) {
          logger.warn(
            { err, tempId: entity.tempId, profileSlug: entity.profileSlug },
            "Entity upsert failed, skipping"
          );
        }
      }

      // ── Phase 3: relations (mirror capture.execute) ───────────────────────
      const createdRelations: Array<{
        sourceEntityId: string;
        targetEntityId: string;
        relationType: string;
      }> = [];

      const relDefRepo = new RelationDefRepository(database);
      let validRelationSlugs: Set<string>;
      if (workspaceId) {
        try {
          const allDefs = await relDefRepo.list(workspaceId);
          validRelationSlugs = new Set(allDefs.map((d) => d.slug));
        } catch {
          validRelationSlugs = new Set([FALLBACK_RELATION_TYPE]);
        }
      } else {
        validRelationSlugs = new Set([FALLBACK_RELATION_TYPE]);
      }

      for (const rel of input.relations) {
        const sourceId = tempToReal[rel.sourceTempId];
        const targetId = tempToReal[rel.targetTempId];
        if (!sourceId || !targetId || sourceId === targetId) continue;

        const relationType = validRelationSlugs.has(rel.relationType)
          ? rel.relationType
          : FALLBACK_RELATION_TYPE;

        try {
          await relationRepo.create(
            {
              id: randomUUID(),
              sourceEntityId: sourceId,
              targetEntityId: targetId,
              type: relationType,
              workspaceId,
              userId,
            },
            userId
          );
          createdRelations.push({
            sourceEntityId: sourceId,
            targetEntityId: targetId,
            relationType,
          });
        } catch (err) {
          logger.warn(
            { err, sourceId, targetId, relationType },
            "Relation creation failed, skipping"
          );
        }
      }

      logger.info(
        {
          userId,
          propertiesCreated,
          propertiesRemapped,
          propertiesFailed: propertiesFailed.length,
          entitiesCreated: created.filter((c) => c.action === "created").length,
          entitiesMatched: created.filter((c) => c.action === "matched").length,
          entitiesUpdated: created.filter((c) => c.action === "updated").length,
          entitiesLinked: created.filter((c) => c.action === "linked").length,
          relationsCreated: createdRelations.length,
        },
        "Capture executeWithSchema completed"
      );

      // Emit capture.complete event (same contract as capture.execute)
      if (created.length > 0) {
        const captureEventId = _captureUUID();
        const entityIds = created.map((c) => c.entityId);
        const profileSlugs = [...new Set(created.map((c) => c.profileSlug))];
        const eventData = {
          workspaceId: workspaceId ?? undefined,
          entityIds,
          profileSlugs,
          entityCount: created.filter((c) => c.action !== "linked").length,
          linkedCount: created.filter((c) => c.action === "linked").length,
        };

        // Per-entity side-effects: search indexing, embeddings, webhooks.
        for (const c of created) {
          if (c.action === "created") {
            emitSideEffects({
              subjectType: "entity",
              action: "create",
              subjectId: c.entityId,
              userId,
              workspaceId: workspaceId ?? undefined,
              data: { source: "import", profileSlug: c.profileSlug },
            }).catch(() => {});
          }
        }

        emitSideEffects({
          subjectType: "capture",
          action: "complete",
          subjectId: captureEventId,
          userId,
          workspaceId: workspaceId ?? undefined,
          data: eventData,
        }).catch(() => {}); // fire-and-forget

        eventRepository
          .append({
            id: captureEventId,
            version: "v1",
            type: "capture.complete.completed",
            subjectType: "capture",
            data: eventData,
            userId,
            source: "api",
            timestamp: new Date(),
          })
          .catch(() => {}); // non-blocking

        // Hydration welcome — Gap 3 of onboarding: Orchestrator posts a short
        // proactive summary in the user's personal channel after they finish
        // the import review. Handled async by the hydration-summary-post worker
        // (delayed ~6s so /home renders first). Fire-and-forget.
        //
        // Aggregate per-profile + per-source counts and new-property counts
        // from the input + created arrays so the worker can render a
        // specific, human-tuned message without hitting the DB.
        const entitiesByProfile: Record<string, number> = {};
        for (const c of created) {
          entitiesByProfile[c.profileSlug] =
            (entitiesByProfile[c.profileSlug] ?? 0) + 1;
        }

        const sourcesSummary: Record<string, number> = {};
        for (const e of input.entities) {
          const src = e.source ?? "import";
          sourcesSummary[src] = (sourcesSummary[src] ?? 0) + 1;
        }

        emitSideEffects({
          subjectType: "hydration",
          action: "imported",
          subjectId: randomUUID(),
          userId,
          workspaceId: workspaceId ?? undefined,
          data: {
            entitiesByProfile,
            sourcesSummary,
            propertiesCreated,
            totalCreated: created.filter((c) => c.action === "created").length,
            totalMatched: created.filter(
              (c) => c.action === "matched" || c.action === "linked"
            ).length,
          },
        }).catch(() => {}); // fire-and-forget
      }

      return {
        propertiesCreated,
        propertiesRemapped,
        propertiesFailed,
        created,
        relations: createdRelations,
      };
    }),
});
