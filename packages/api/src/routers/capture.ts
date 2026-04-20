/**
 * Capture Router - Unified Capture Pipeline
 *
 * Three endpoints:
 * - thought:    Single-entity classify + create (legacy / SDK)
 * - structure:  Multi-entity extraction + dedup search (AI pipeline step 1)
 * - execute:    Batch entity + relation creation (AI pipeline step 2)
 */

import { z } from "zod";
import { router, workspaceProcedure, podProcedure } from "../trpc.js";
import { requireUserId, requireWorkspaceId } from "../utils/user-scoped.js";
import { aiRateLimitMiddleware } from "../middleware/ai-rate-limit.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import {
  sql,
  getDb,
  EventRepository,
  EntityRepository,
  RelationRepository,
  RelationDefRepository,
  ProfileResolutionService,
} from "@synap/database";
import { searchService } from "@synap/search";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";
import { markServiceCredentialError } from "../utils/credential-auto-repair.js";
import { emitSideEffects } from "@synap/jobs";
import { eventRepository } from "@synap/database";
import { randomUUID as _captureUUID } from "crypto";

const logger = createLogger({ module: "capture-router" });

// ── Default relation type for unknown slugs ────────────────────────────────

const FALLBACK_RELATION_TYPE = "relates_to";

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
        const availableProfiles = accessibleProfiles
          .filter(
            (p) => !(p.uiHints as Record<string, unknown>)?.hideFromCreate
          )
          .map((p) => ({
            slug: p.slug,
            displayName: p.displayName || p.slug,
            description:
              ((p.uiHints as Record<string, unknown>)?.description as string) ||
              undefined,
            propertyHints:
              (
                p as { effectiveProperties?: Array<{ slug: string }> }
              ).effectiveProperties
                ?.map((prop) => prop.slug)
                .join(", ") || undefined,
          }));

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
      const availableProfiles = accessibleProfiles
        .filter((p) => !(p.uiHints as Record<string, unknown>)?.hideFromCreate)
        .map((p) => ({
          slug: p.slug,
          displayName: p.displayName || p.slug,
          description:
            ((p.uiHints as Record<string, unknown>)?.description as string) ||
            undefined,
          propertyHints:
            (
              p as { effectiveProperties?: Array<{ slug: string }> }
            ).effectiveProperties
              ?.map((prop) => prop.slug)
              .join(", ") || undefined,
        }));

      // 2. Call IS /api/structure
      const { client } = await resolveIntelligenceService({
        userId,
        workspaceId: workspaceId ?? undefined,
        capability: "default",
      });

      const structureResult = await client.structure({
        text: input.text,
        url: input.url,
        html: input.html,
        context: input.context,
        hints: { availableProfiles, previousEntities: input.previousEntities },
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
        dedupCandidates,
      };
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
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // workspaceId is optional — EntityRepository will resolve `null` for
      // pod-wide profiles (entityScope='pod') and throw for workspace-scoped
      // profiles when the user has no workspace context.
      const workspaceId = ctx.workspaceId;

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
});
