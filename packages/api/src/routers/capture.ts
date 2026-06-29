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
import {
  resolveIntelligenceService,
  IntelligenceAuthError,
} from "../utils/intelligence-routing.js";
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
  DocumentRepository,
  PropertyValidationError,
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
import { eventRepository, linkEntityToProject } from "@synap/database";
import { resolveContentTarget } from "../import/materialize-document.js";
import {
  materializeCompositeGraph,
  createRelationsFromRefs,
} from "../utils/materialize-composite.js";
import { makeExternalLinkIdempotency } from "../utils/entity-link-idempotency.js";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";

const logger = createLogger({ module: "capture-router" });

// ── Default relation type for unknown slugs ────────────────────────────────

const FALLBACK_RELATION_TYPE = "relates_to";

// ── ek_type inference (knowledge profile discriminator) ────────────────────
// The `knowledge` profile requires an ek_type (gotcha|lesson|decision|reference).
// IS structuring identifies the profile but does not always set ek_type — infer
// it from the text via a keyword sniff so entity creation succeeds instead of
// degrading to a note. ONE helper, called by both the single-entity (thought)
// and multi-entity (structure) paths.
function inferEkType(
  text: string
): "gotcha" | "lesson" | "decision" | "reference" | undefined {
  const haystack = text.toLowerCase();
  if (haystack.includes("gotcha")) return "gotcha";
  if (haystack.includes("lesson")) return "lesson";
  if (haystack.includes("decision")) return "decision";
  if (haystack.includes("reference")) return "reference";
  return undefined;
}

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

/**
 * Build a human-readable summary from composite capture operations by extracting
 * entity titles from `create_entity` ops. Shows up to 2 titles plus a "+N more"
 * suffix so the proposal inbox carries real entity names instead of a bare count.
 */
export function buildCaptureSummary(
  operations: ReadonlyArray<{ op?: unknown; title?: unknown }>
): string {
  const titles: string[] = [];
  for (const op of operations) {
    if (op.op === "create_entity" && typeof op.title === "string") {
      titles.push(op.title);
    }
  }
  if (titles.length === 0) return "Capture";
  if (titles.length === 1) return `Captured: ${titles[0]}`;
  if (titles.length === 2) return `Captured: ${titles[0]}, ${titles[1]}`;
  return `Captured: ${titles[0]}, ${titles[1]}, +${titles.length - 2} more`;
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

          // Knowledge profile requires ek_type — infer from the leading text
          // when IS omitted it (see inferEkType).
          if (profileSlug === "knowledge" && !properties.ek_type) {
            const ek = inferEkType(input.content.slice(0, 30));
            if (ek) properties.ek_type = ek;
          }

          mode = "ai";
          logger.debug(
            { userId, profileSlug, confidence: entity.confidence },
            "Thought classified by IS"
          );
        }
      } catch (err) {
        // Only an upstream auth failure (401/403) means the pod's IS
        // credentials are bad — mark credential_error so the frontend can
        // drive re-provisioning. Every other failure (validation, timeout,
        // 5xx, network) is a transient/degraded condition: fall back to a
        // note WITHOUT poisoning the credential status.
        if (err instanceof IntelligenceAuthError) {
          logger.warn(
            { err, userId, status: err.status },
            "IS classification auth failure — marking credential_error, falling back to note"
          );
          markServiceCredentialError();
        } else {
          logger.warn(
            { err, userId },
            "IS classification failed (non-auth) — falling back to note"
          );
        }
      }

      // Merge optional URL into properties for bookmark-family profiles
      if (input.url) {
        properties = { url: input.url, ...properties };
      }

      // Step 2: Create entity
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(database, eventRepo);

      // Long-form thought body → real versioned document (storage + v1 +
      // Typesense), linked via documentId. Short content is kept inline as
      // properties.content so the full body survives even when the 80-char
      // title truncates it. Shared single decision point; never blocks capture.
      const { documentId, inlineContent } = await resolveContentTarget({
        content: input.content,
        title,
        userId,
        workspaceId,
        db: database,
        eventRepo,
        logContext: { userId },
      });
      if (inlineContent !== undefined) {
        properties = { ...properties, content: inlineContent };
      }

      // Salvage properties (kept for the note fallback): the generic content/url
      // a note accepts — and the document link — so the user's body is never
      // lost regardless of which fallback path runs.
      const salvageProperties = {
        ...(input.url ? { url: input.url } : {}),
        ...(inlineContent !== undefined ? { content: inlineContent } : {}),
      };

      const originalProfileSlug = profileSlug;
      // Additive provenance: degradedFrom set only when the final note fallback
      // runs; propertiesDropped set only when the same-profile retry salvaged
      // the typed profile by dropping its properties.
      let degradedFrom: string | undefined;
      let propertiesDropped: true | undefined;

      let entity: Awaited<ReturnType<typeof entityRepo.create>>;
      try {
        entity = await entityRepo.create(
          {
            workspaceId: workspaceId,
            userId,
            title,
            properties,
            documentId,
            profileSlug,
          },
          userId
        );
      } catch (err) {
        // A PropertyValidationError means the PROFILE is valid but one of the
        // typed properties failed schema validation — salvage the typed profile
        // by retrying ONCE with the same profileSlug and properties stripped to
        // the generic note-safe set, instead of throwing the profile away.
        if (err instanceof PropertyValidationError) {
          try {
            logger.warn(
              { err, userId, profileSlug },
              "Entity creation failed validation — retrying same profile with properties dropped"
            );
            entity = await entityRepo.create(
              {
                workspaceId: workspaceId,
                userId,
                title,
                properties: salvageProperties,
                documentId,
                profileSlug,
              },
              userId
            );
            propertiesDropped = true;
          } catch (retryErr) {
            // Same-profile retry still failed — last resort: fall back to note.
            logger.warn(
              { err: retryErr, userId, profileSlug },
              "Same-profile retry failed, falling back to note"
            );
            entity = await entityRepo.create(
              {
                workspaceId: workspaceId,
                userId,
                title,
                properties: salvageProperties,
                documentId,
                profileSlug: "note",
              },
              userId
            );
            degradedFrom = originalProfileSlug;
            profileSlug = "note";
            mode = "fallback";
          }
        } else {
          // Not a property validation error (e.g. profile not accessible) —
          // stripping properties wouldn't help; fall back to note directly.
          logger.warn(
            { err, userId, profileSlug },
            "Entity creation failed (non-validation), falling back to note"
          );
          entity = await entityRepo.create(
            {
              workspaceId: workspaceId,
              userId,
              title,
              properties: salvageProperties,
              documentId,
              profileSlug: "note",
            },
            userId
          );
          degradedFrom = originalProfileSlug;
          profileSlug = "note";
          mode = "fallback";
        }
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
        // Additive: original AI-chosen slug, only when the note fallback ran.
        ...(degradedFrom ? { degradedFrom } : {}),
        // Additive: true when the same-profile retry succeeded sans properties.
        ...(propertiesDropped ? { propertiesDropped: true as const } : {}),
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
        // Optional now: a binary input (PDF/photo/docx/audio) can arrive via
        // `file` and be normalized to text by IS's extractor before structuring.
        text: z.string().max(8000).optional(),
        /** Binary/text source normalized to text by IS before structuring. */
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

      // Text is optional now (a `file` may carry the payload instead); guard
      // every `input.text` use. The note-fallback below needs SOME text, so use
      // a safe local that prefers text and falls back to a filename hint.
      const inputText =
        input.text ??
        (input.file?.filename ? `[file: ${input.file.filename}]` : "");

      logger.debug(
        { userId, contentLength: input.text?.length ?? 0 },
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
          inputText.slice(0, 200),
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

      // Degraded fallback proposal — a single note carrying the raw text, so a
      // capture is never lost when the IS can't structure it. `degraded` +
      // `degradedReason` are ADDITIVE response fields (published api-types
      // clients that don't read them are unaffected) that tell the caller this
      // came from the fallback path, and WHY:
      //   is_auth_error      — IS rejected the pod credentials (401/403)
      //   is_invalid_response — IS reachable but returned null (5xx/validation/
      //                         timeout/network) — NOT a credentials problem
      const degradedFallback = (
        degradedReason:
          | "is_auth_error"
          | "is_invalid_response"
          | "is_empty_result"
      ) => ({
        proposals: [
          {
            tempId: "t1",
            profileSlug: "note",
            title: inputText.slice(0, 80).trim(),
            description: inputText.length > 80 ? inputText : undefined,
            properties: { content: inputText },
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
        degraded: true as const,
        degradedReason,
      });

      let structureResult: Awaited<ReturnType<typeof client.structure>>;
      try {
        structureResult = await client.structure({
          text: input.text ?? "",
          file: input.file,
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
      } catch (err) {
        // Only an upstream auth failure reaches here as a throw — the client
        // returns null for every non-auth failure. This is the ONLY path that
        // should mark credential_error and trigger the re-provisioning loop.
        if (err instanceof IntelligenceAuthError) {
          logger.warn(
            { userId, status: err.status },
            "IS structure auth failure — marking service as credential_error"
          );
          markServiceCredentialError();
          return degradedFallback("is_auth_error");
        }
        throw err;
      }

      if (!structureResult) {
        // IS reachable but did not return a usable structure (5xx, validation
        // error, timeout, network). This is NOT a credentials problem — do NOT
        // mark credential_error. Return a degraded fallback so the capture is
        // preserved and the caller can surface the real (non-auth) cause.
        logger.warn(
          { userId },
          "IS structure failed (non-auth) — returning degraded fallback, credential status left unchanged"
        );
        return degradedFallback("is_invalid_response");
      }

      // 1b. Silent-empty guard. The IS can return a well-formed 200 with ZERO
      // entities and no followUp — e.g. when the model is over budget, the
      // provider degraded, or the completion came back empty. Returning that as
      // a success ({ proposals: [] }) would violate the trust contract: the user
      // gave us text and we'd silently hand back nothing, not flagged as
      // degraded. A followUp is a legitimate non-empty outcome (the model is
      // asking a question), so only treat the truly-empty case as degraded.
      if (!structureResult.followUp && structureResult.entities.length === 0) {
        logger.warn(
          { userId },
          "IS returned zero entities without error — marking degraded (is_empty_result)"
        );
        return degradedFallback("is_empty_result");
      }

      // Knowledge profile requires ek_type — infer from each entity's title when
      // IS omitted it (see inferEkType), so entity creation succeeds instead of
      // degrading to note.
      for (const entity of structureResult.entities) {
        if (
          entity.profileSlug === "knowledge" &&
          !(entity.properties as Record<string, unknown>).ek_type
        ) {
          const ek = inferEkType(entity.title || "");
          if (ek) (entity.properties as Record<string, unknown>).ek_type = ek;
        }
      }

      // Additive extraction summary from the IS response (present when a `file`
      // input was normalized to text upstream). Passed through to the tRPC
      // caller without changing existing fields — published clients ignore it.
      const extractionPassThrough = structureResult.extraction
        ? { extraction: structureResult.extraction }
        : {};

      // 2. If followUp, pass through immediately (no dedup yet)
      if (structureResult.followUp) {
        return {
          proposals: structureResult.entities,
          relations: structureResult.relations,
          followUp: structureResult.followUp,
          targetWorkspaceId: structureResult.targetWorkspaceId ?? null,
          targetWorkspaceReason: structureResult.targetWorkspaceReason ?? null,
          targetWorkspaceConfidence:
            structureResult.targetWorkspaceConfidence ?? null,
          dedupCandidates: {} as Record<
            string,
            Array<{
              entityId: string;
              title: string;
              profileSlug: string;
              score: number;
            }>
          >,
          ...extractionPassThrough,
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

      // When a dedup lookup throws (Typesense down/timeout), dedupCandidates is
      // left empty for that entity — which is indistinguishable from "checked,
      // found nothing". Track failures so the response can carry an ADDITIVE
      // dedupSkipped flag, letting the caller tell "no duplicates" apart from
      // "didn't check". (published api-types clients that ignore it are unaffected)
      let dedupSkipped = false;

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
          } catch (err) {
            // Search failed for this entity — skip dedup
            dedupSkipped = true;
            logger.warn(
              { err, userId, tempId: entity.tempId },
              "Dedup search failed for entity — marking dedupSkipped"
            );
            dedupCandidates[entity.tempId] = [];
          }
        }
      } catch (err) {
        // Typesense not available — skip all dedup
        dedupSkipped = true;
        logger.warn(
          { err, userId },
          "Typesense unavailable, skipping dedup search — marking dedupSkipped"
        );
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
        targetWorkspaceReason: structureResult.targetWorkspaceReason ?? null,
        targetWorkspaceConfidence:
          structureResult.targetWorkspaceConfidence ?? null,
        dedupCandidates,
        // Additive: true when one or more dedup searches threw, so the caller
        // can distinguish "checked, no duplicates" from "didn't check". Omitted
        // when all searches succeeded.
        ...(dedupSkipped ? { dedupSkipped: true as const } : {}),
        // Forward the degraded signal from IS so callers can distinguish a
        // real classification from a confidence-0.3 fallback note. The note is
        // still written (preserving user text), but callers now know WHY.
        degraded: (structureResult as { degraded?: boolean }).degraded ?? false,
        ...((structureResult as { degradedReason?: string }).degradedReason !==
        undefined
          ? {
              degradedReason: (structureResult as { degradedReason?: string })
                .degradedReason,
            }
          : {}),
        ...extractionPassThrough,
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
            /**
             * Long-form body. When present AND long-form (per
             * shouldMaterializeAsDocument), it is materialized as a versioned
             * document linked via entity.documentId; short content stays in
             * properties.content.
             */
            content: z.string().optional(),
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
        /**
         * Disposition (P3 — store-vs-extract). When true AND `file` is present,
         * the ORIGINAL source blob is stored and linked to the primary created
         * entity. Default (absent/false) = today's extract-and-discard behavior:
         * the binary is dropped and only the extracted entities are kept.
         */
        keepRaw: z.boolean().optional(),
        /**
         * The original source blob the client re-sends so it can be preserved
         * when `keepRaw` is true. ONE file per capture (top-level, not per
         * entity). `content` is base64-encoded. Ignored unless `keepRaw`.
         */
        file: z
          .object({
            // ≈5MB binary as base64 (base64 inflates ~1.37×). Caps the raw
            // blob so an oversized payload can't OOM the pod (DoS guard).
            content: z
              .string()
              .max(7_000_000, "file.content too large (max ~5MB)"),
            mimeType: z.string(),
            filename: z.string().optional(),
          })
          .optional(),
        /**
         * Client-stable idempotency namespace (U1). When supplied, a retry of
         * this execute with the SAME key links the entities it already created
         * (keyed by `${key}:${tempId}`) instead of duplicating them. Distinct
         * tempIds → distinct keys, so two same-named entities stay separate.
         * Optional / back-compat — absent = unchanged behavior.
         */
        idempotencyKey: z.string().max(200).optional(),
        /**
         * Active project lens (or a surface/cell-renderer override) at capture
         * time. When set, every created entity is filed into this project
         * (`belongs_to_project`) — the project mirror of the active workspace.
         */
        projectId: z.string().uuid().nullish(),
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

      // Capture is the post-approval DIRECT write (the user already reviewed the
      // AI's structure output), so it materializes through the SHARED composite
      // orchestrator with injected direct-write callers: the loop owns
      // ref-resolution + relation creation; the callers own write policy
      // (content→document routing, retry-as-note, relation-slug fallback).

      // Prefetch valid relation slugs for this workspace (avoids N+1).
      // Workspace-less callers (hydration) get the fallback only.
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

      // Adapt capture input → composite ops (ref = tempId so the response maps
      // back). Entities first (op contract requires a create_entity first).
      const operations: CompositeProposalOperation[] = [
        ...input.entities.map((e) => ({
          op: "create_entity" as const,
          profileSlug: e.profileSlug,
          title: e.title,
          description: e.description,
          properties: e.properties,
          content: e.content,
          existingEntityId: e.existingEntityId,
          ref: e.tempId,
        })),
        ...input.relations.map((r) => ({
          op: "create_relation" as const,
          type: r.relationType,
          sourceRef: r.sourceTempId,
          targetRef: r.targetTempId,
        })),
      ];

      // Direct-write entity caller: shared content routing + retry-as-note,
      // returning the ACTUAL profile created so the response reflects fallbacks.
      const entityCaller = {
        create: async (op: {
          profileSlug: string;
          title?: string;
          description?: string;
          properties?: Record<string, unknown>;
          content?: string;
        }) => {
          const { documentId, inlineContent } = await resolveContentTarget({
            content: op.content,
            title: op.title,
            userId,
            workspaceId,
            db: database,
            eventRepo,
            logContext: { profileSlug: op.profileSlug },
          });
          const properties: Record<string, unknown> = {
            ...(op.properties ?? {}),
            ...(inlineContent !== undefined ? { content: inlineContent } : {}),
          };
          // Note-safe property set, kept regardless of which fallback runs so
          // the materialized document link + content survive a downgrade.
          const salvageProperties: Record<string, unknown> =
            inlineContent !== undefined ? { content: inlineContent } : {};
          try {
            const e = await entityRepo.create(
              {
                workspaceId,
                userId,
                title: op.title,
                preview: op.description,
                properties,
                documentId,
                profileSlug: op.profileSlug,
              },
              userId
            );
            return { id: e.id, profileSlug: op.profileSlug };
          } catch (err) {
            // PropertyValidationError = valid profile, invalid property. Salvage
            // the typed profile by retrying ONCE with the same slug, properties
            // stripped, before falling back to note.
            if (err instanceof PropertyValidationError) {
              try {
                logger.warn(
                  { err, profileSlug: op.profileSlug },
                  "Entity creation failed validation — retrying same profile with properties dropped"
                );
                const s = await entityRepo.create(
                  {
                    workspaceId,
                    userId,
                    title: op.title,
                    preview: op.description,
                    properties: salvageProperties,
                    documentId,
                    profileSlug: op.profileSlug,
                  },
                  userId
                );
                return {
                  id: s.id,
                  profileSlug: op.profileSlug,
                  propertiesDropped: true as const,
                };
              } catch (retryErr) {
                logger.warn(
                  { err: retryErr, profileSlug: op.profileSlug },
                  "Same-profile retry failed, falling back to note"
                );
              }
            } else {
              logger.warn(
                { err, profileSlug: op.profileSlug },
                "Entity creation failed (non-validation), falling back to note"
              );
            }
            const f = await entityRepo.create(
              {
                workspaceId,
                userId,
                title: op.title,
                preview: op.description,
                properties: salvageProperties,
                documentId,
                profileSlug: "note",
              },
              userId
            );
            return {
              id: f.id,
              profileSlug: "note",
              degradedFrom: op.profileSlug,
            };
          }
        },
      };

      const relationCaller = {
        create: async (rel: {
          sourceEntityId: string;
          targetEntityId: string;
          type: string;
        }) =>
          relationRepo.create(
            {
              id: randomUUID(),
              sourceEntityId: rel.sourceEntityId,
              targetEntityId: rel.targetEntityId,
              type: rel.type,
              workspaceId,
              userId,
            },
            userId
          ),
      };

      const result = await materializeCompositeGraph(
        operations,
        entityCaller,
        relationCaller,
        (err, type) =>
          logger.warn({ err, type }, "Relation creation failed, skipping"),
        {
          source: "capture",
          resolveRelationType: (type) =>
            validRelationSlugs.has(type) ? type : FALLBACK_RELATION_TYPE,
          // U1: when the caller supplies a stable key, a retry links the
          // entities it already created (keyed by `${key}:${tempId}`) instead of
          // duplicating. Absent → no idempotency (unchanged).
          ...(input.idempotencyKey
            ? {
                idempotency: makeExternalLinkIdempotency(database, {
                  // userId-scoped: capture's idempotencyKey is CLIENT-supplied,
                  // so without this a colliding key could link another tenant's
                  // entity (the global provider/externalId index). Prefixing the
                  // user id makes cross-tenant collision impossible.
                  namespace: `${userId}:${input.idempotencyKey}`,
                  provider: "capture",
                  userId,
                }),
              }
            : {}),
        }
      );

      const created = result.entities.map((e) => ({
        tempId: e.ref ?? "",
        entityId: e.entityId,
        profileSlug: e.profileSlug,
        linked: e.linked,
        // Additive: original slug when this entity was downgraded to a note.
        ...(e.degradedFrom ? { degradedFrom: e.degradedFrom } : {}),
        // Additive: true when the typed profile was salvaged sans properties.
        ...(e.propertiesDropped ? { propertiesDropped: true as const } : {}),
      }));
      const createdRelations = result.relations.map((r) => ({
        sourceEntityId: r.sourceEntityId,
        targetEntityId: r.targetEntityId,
        relationType: r.type,
      }));

      // Project membership (lens-context): file the captured entities into the
      // active project. Capture materializes directly (not via proposal
      // approval), so the membership write lands here — the project mirror of
      // how `workspaceId` is stamped on the entity. Idempotent, best-effort.
      if (input.projectId) {
        const newEntityIds = created
          .filter((c) => !c.linked)
          .map((c) => c.entityId);
        for (const entityId of newEntityIds) {
          await linkEntityToProject(database, {
            entityId,
            projectId: input.projectId,
            userId,
            workspaceId: workspaceId ?? null,
          });
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

      // Track 3 — record-and-materialize. The write above is an already-done
      // first-party capture; record it as a persistent `auto_approved` proposal
      // so the capture is traceable, shows in the Proposals app, and can be
      // reverted (revert reads `data.materialized.entityIds`). BEST-EFFORT: a
      // recording hiccup must NEVER fail the capture (same discipline as the
      // keepRaw block below). NOT routed through checkPermissionOrPropose — this
      // RECORDS an already-committed first-party write, it does not ask permission.
      if (created.length > 0) {
        try {
          const { createAutoApprovedProposal } =
            await import("../utils/event-backed-proposal.js");
          const materializedEntityIds = created
            .filter((c) => !c.linked)
            .map((c) => c.entityId);
          await createAutoApprovedProposal({
            userId,
            reviewedBy: userId,
            workspaceId: workspaceId ?? null,
            projectId: input.projectId ?? null,
            targetType: "entity",
            targetId: randomUUID(),
            proposalType: "capture.graph",
            action: "graph",
            source: "capture",
            summary: buildCaptureSummary(operations),
            data: {
              operations,
              source: "capture",
              materialized: { entityIds: materializedEntityIds },
            },
          });
        } catch (err) {
          logger.warn(
            { err, userId },
            "Track 3: capture proposal record failed (capture preserved)"
          );
        }
      }

      // P3 — Disposition (store-vs-extract). DEFAULT (no keepRaw / no file) is
      // byte-identical to today: the binary is dropped, only entities survive.
      // OPT-IN: when keepRaw && file, preserve the ORIGINAL source blob and link
      // it to the PRIMARY created entity via entity.documentId (the canonical
      // entity↔document link, same as materialize-document.ts). Best-effort —
      // a storage hiccup NEVER fails the capture (the entities are already in).
      if (input.keepRaw && input.file) {
        // Primary = first freshly created (non-linked) entity, else first overall.
        const primary =
          created.find((c) => !c.linked) ?? created[0] ?? undefined;
        if (primary?.entityId) {
          try {
            const { storage } = await import("@synap/storage");
            const ext = (input.file.mimeType.split("/")[1] || "bin")
              .split(";")[0]
              .split("+")[0];
            const buffer = Buffer.from(input.file.content, "base64");
            const key = storage.buildPath(
              userId,
              "entity",
              primary.entityId,
              ext
            );
            const metadata = await storage.upload(key, buffer, {
              contentType: input.file.mimeType,
            });

            // Map mimeType → document `type` (the only typed enum it accepts).
            // Binary blobs are NOT given `content` (that's a text v1 snapshot).
            const docType: "text" | "markdown" | "code" | "pdf" | "docx" =
              input.file.mimeType === "application/pdf" ? "pdf" : "text";

            const docRepo = new DocumentRepository(database, eventRepo);
            const createdDocument = await docRepo.create(
              {
                title: input.file.filename || "Source file",
                type: docType,
                storageUrl: metadata.url,
                storageKey: metadata.path,
                size: metadata.size,
                mimeType: input.file.mimeType,
                userId,
                workspaceId: workspaceId ?? undefined,
              },
              userId
            );

            // Record the raw source blob as PROVENANCE on the primary entity
            // WITHOUT clobbering entity.documentId. The primary may already
            // carry an extracted-content document (set by entityCaller.create
            // via resolveContentTarget → materializeContentDocument); overwriting
            // documentId here would orphan that long-form note body. Instead we
            // merge two properties — entityRepo.update MERGES properties (it does
            // NOT replace), and unknown property keys are preserved by the
            // validation service — so the extracted documentId stays intact.
            await entityRepo.update(
              primary.entityId,
              {
                properties: {
                  sourceFileDocumentId: createdDocument.id,
                  sourceFileUrl: metadata.url,
                },
              },
              userId
            );

            logger.info(
              {
                userId,
                entityId: primary.entityId,
                sourceFileDocumentId: createdDocument.id,
              },
              "P3: raw source blob stored and recorded as provenance on primary entity"
            );
          } catch (err) {
            // Never fail the capture on a storage hiccup — log and continue.
            logger.warn(
              { err, userId, entityId: primary.entityId },
              "P3: raw source blob storage failed (capture preserved)"
            );
          }
        }
      }

      // Emit capture.complete event — enables automation triggers + event log audit trail
      if (created.length > 0) {
        const captureEventId = randomUUID();
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

      // ── Phase 3: relations (shared loop — the SAME relation definition the
      // composite orchestrator uses; only the entity phase above differs, via
      // EntityUpsertService dedup). tempToReal IS a ref→realId map (ref=tempId).
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

      const createdRelations = (
        await createRelationsFromRefs(
          input.relations.map((r) => ({
            sourceRef: r.sourceTempId,
            targetRef: r.targetTempId,
            type: r.relationType,
          })),
          tempToReal,
          {
            create: async (rel: {
              sourceEntityId: string;
              targetEntityId: string;
              type: string;
            }) =>
              relationRepo.create(
                {
                  id: randomUUID(),
                  sourceEntityId: rel.sourceEntityId,
                  targetEntityId: rel.targetEntityId,
                  type: rel.type,
                  workspaceId,
                  userId,
                },
                userId
              ),
          },
          {
            resolveRelationType: (t) =>
              validRelationSlugs.has(t) ? t : FALLBACK_RELATION_TYPE,
            onError: (err, type) =>
              logger.warn({ err, type }, "Relation creation failed, skipping"),
          }
        )
      ).map((r) => ({
        sourceEntityId: r.sourceEntityId,
        targetEntityId: r.targetEntityId,
        relationType: r.type,
      }));

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
        const captureEventId = randomUUID();
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
