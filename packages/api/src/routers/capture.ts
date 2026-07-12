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
import type { Context } from "../context.js";
import { entitiesRouter } from "./entities.js";
import { requireUserId, requireWorkspaceId } from "../utils/user-scoped.js";
import { aiRateLimitMiddleware } from "../middleware/ai-rate-limit.js";
import {
  resolveIntelligenceService,
  IntelligenceAuthError,
} from "../utils/intelligence-routing.js";
import type { StructuredFollowUp } from "@synap/intelligence-client";
import {
  eq,
  and,
  or,
  isNull,
  isNotNull,
  inArray,
  desc,
  getDb,
  db,
  entityVectors,
  entities as entitiesTable,
  drizzleSql,
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
  projects,
  links,
  type LinkEndpointType,
  type LinkType,
  type PropertyValueType,
  type IdentitySignal,
  resolveIdentity,
  extractIdentitySignals,
  resolveRolePayload,
  resolveWorkspacePlacement,
  type ResolutionRung,
} from "@synap/database";
import {
  userVisibleWhere,
  workspaceLensWhere,
} from "../utils/user-visible-where.js";
import {
  embedQuery,
  MAX_VECTOR_DISTANCE,
} from "../services/retrieval/hybrid-recall.js";
import {
  fetchRoutingMemory,
  fetchWorkspaceRoutingThreshold,
} from "../services/routing-memory.js";
import { AI_KIND, BELOW_GATE_CONFIDENCE } from "../lib/ai-events.js";
import { type CaptureRoutingResult } from "../lib/capture-routing.js";
import { reconcileWorkspaceByName } from "../lib/workspace-name-reconcile.js";
import { isRoutableWorkspaceType } from "../lib/routing-candidates.js";
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
import { emitAiDecision } from "../utils/ai-feedback-events.js";
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

// ── Dedup candidate scoring (honest title similarity) ───────────────────────
// Typesense `text_match` is a BM25-style keyword-relevance integer, NOT a
// similarity score — it is meaningless outside a single query's own ranking.
// Normalizing by the batch's own max (old code) made the #1 result of EVERY
// query score 1.0, even fuzzy junk, which the frontend's AUTO_LINK_THRESHOLD
// (0.85) treats as "safe to auto-merge". Score title similarity directly
// instead: exact (case/whitespace-insensitive) match = 1.0, otherwise a
// Jaccard token-overlap ratio in [0,1).
function titleSimilarity(a: string, b: string): number {
  const normA = a.toLowerCase().trim();
  const normB = b.toLowerCase().trim();
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const tokensA = new Set(normA.split(/\s+/).filter(Boolean));
  const tokensB = new Set(normB.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Below this similarity, a Typesense hit is fuzzy/keyword noise, not a real
// dedup candidate — drop it rather than surface it at a misleadingly low
// score (the frontend already treats "any candidate present" as a hint).
const DEDUP_SIMILARITY_FLOOR = 0.5;

// Interactive-capture structure timeout. The client default is 25s; a longer
// prose input decodes more entities and its generation can cross 25s, aborting
// the backend→IS fetch → a null result → a degraded raw note (dogfooding hit
// exactly this). The deep-import path already uses 60s; 45s is the interactive
// budget (capture is optimistic/async — a slightly longer wait beats a degrade).
const STRUCTURE_TIMEOUT_MS = 45_000;

// ── Workspace routing (shared across ALL capture doors) ─────────────────────
// The pure routing decision + its types live in `lib/capture-routing` (a
// testable leaf); the gate tunables live in the `lib/ai-events` SSOT.

type DedupCandidate = {
  entityId: string;
  title: string;
  profileSlug: string;
  score: number;
};

/**
 * Semantic dedup — cosine search over the SAME pgvector infra the retrieval
 * engine uses (`embedQuery` + `entity_vectors`, see hybrid-recall.ts), rather
 * than a second copy of it. Embeds the candidate title (+ a short content
 * snippet when available) and finds existing entities whose stored embedding
 * is close, so a paraphrase ("Q3 roadmap review" vs "Quarterly roadmap sync")
 * can be caught even when the titles share no tokens.
 *
 * Workspace scoping mirrors hybridRecall's own limitation: `entity_vectors`
 * carries no `workspaceId` column, so the vector half is joined to `entities`
 * to apply the real workspace lens (hybridRecall's Typesense half is the one
 * that workspace-scopes today; its pgvector half is userId-only). Degrades to
 * an empty list — never throws — so a missing IS/embedding never blocks
 * capture.
 */
async function semanticDedupCandidates(
  title: string,
  content: string | undefined,
  userId: string,
  workspaceId: string | null | undefined,
  limit = 3
): Promise<DedupCandidate[]> {
  const text = content ? `${title}\n${content.slice(0, 500)}` : title;
  const embedding = await embedQuery(text);
  if (!embedding) return [];

  const vecLiteral = `[${embedding.join(",")}]`;
  try {
    const rows = await db
      .select({
        entityId: entityVectors.entityId,
        title: entityVectors.title,
        entityType: entityVectors.entityType,
        distance: drizzleSql<number>`${entityVectors.embedding} <=> ${vecLiteral}::vector`,
      })
      .from(entityVectors)
      .innerJoin(entitiesTable, eq(entitiesTable.id, entityVectors.entityId))
      .where(
        and(
          eq(entityVectors.userId, userId),
          drizzleSql`${entityVectors.embedding} <=> ${vecLiteral}::vector <= ${MAX_VECTOR_DISTANCE}`,
          workspaceLensWhere(
            entitiesTable.workspaceId,
            userId,
            workspaceId ?? undefined
          )
        )
      )
      .orderBy(drizzleSql`${entityVectors.embedding} <=> ${vecLiteral}::vector`)
      .limit(limit);

    return rows.map((r) => ({
      entityId: r.entityId,
      title: r.title ?? "",
      profileSlug: r.entityType || "note",
      score: 1 - Number(r.distance),
    }));
  } catch (err) {
    logger.warn(
      { err, userId },
      "Semantic dedup query failed — degrading to empty"
    );
    return [];
  }
}

/** Merge candidate lists from multiple dedup sources, keeping the MAX score per entityId. */
function mergeDedupCandidates(...lists: DedupCandidate[][]): DedupCandidate[] {
  const byId = new Map<string, DedupCandidate>();
  for (const list of lists) {
    for (const c of list) {
      const existing = byId.get(c.entityId);
      if (!existing || c.score > existing.score) byId.set(c.entityId, c);
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
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
            const ek = inferEkType(input.content.slice(0, 200));
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

      // Step 2: Create entity — via the main entity door (entities.create),
      // never entityRepo.create directly, so capture gets the same
      // project-linking, session `produced` links, property→relation sync,
      // identity-signal registration, and emit chain every other creator gets.
      const database = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;

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

      const entitiesCaller = entitiesRouter.createCaller(
        ctx as unknown as Context
      );

      // Identity-first: a STRONG signal match (email/phone/url/…) means this
      // subject already exists — skip create and enrich the existing entity
      // instead (dedup by construction). A WEAK/no match proceeds to create;
      // capture must stay zero-friction, so a weak candidate is advisory only.
      const identity = await resolveIdentity(database, {
        userId,
        kindSlug: profileSlug,
        name: title,
        signals: extractIdentitySignals(properties),
        userScope: userVisibleWhere(entitiesTable.workspaceId, userId),
        limit: 5,
      });

      if (identity.match === "strong" && identity.entity) {
        // Defensive: if the enrich fails (e.g. the matched entity isn't
        // writable by this caller), fall through to a normal create rather
        // than failing the capture.
        try {
          const nonEmptyProperties = Object.fromEntries(
            Object.entries(properties).filter(
              ([, v]) => v !== undefined && v !== null && v !== ""
            )
          );
          if (Object.keys(nonEmptyProperties).length > 0) {
            await entitiesCaller.update({
              id: identity.entity.id,
              properties: nonEmptyProperties,
              source: "user",
            });
          }
        } catch (enrichErr) {
          logger.warn(
            { userId, entityId: identity.entity.id, err: enrichErr },
            "Thought dedup enrich failed — returning matched entity unenriched"
          );
        }
        logger.info(
          {
            userId,
            entityId: identity.entity.id,
            profileSlug: identity.entity.type,
          },
          "Thought captured — deduplicated onto existing entity (strong identity match)"
        );
        return {
          success: true,
          entityId: identity.entity.id,
          profileSlug: identity.entity.type,
          title: identity.entity.title ?? title,
          mode,
          // Additive: signals this capture merged into an existing entity
          // instead of creating a new one.
          deduplicated: true as const,
        };
      }

      const originalProfileSlug = profileSlug;
      // Additive provenance: degradedFrom set only when the final note fallback
      // runs; propertiesDropped set only when the same-profile retry salvaged
      // the typed profile by dropping its properties.
      let degradedFrom: string | undefined;
      let propertiesDropped: true | undefined;

      let entityId: string;
      try {
        const created = await entitiesCaller.create({
          profileSlug,
          title,
          properties,
          documentId,
          source: "user",
          // Force the entity into this workspace even for a pod-default
          // profile (person/company) — matches capture's historical
          // literal-workspaceId behavior, unlike the door's default of
          // honoring the profile's pod-wide default.
          workspaceScoped: true,
        });
        entityId = (created as { id: string }).id;
      } catch (err) {
        // A PropertyValidationError means the PROFILE is valid but one of the
        // typed properties failed schema validation — salvage the typed profile
        // by retrying ONCE with the same profileSlug and properties stripped to
        // the generic note-safe set, instead of throwing the profile away.
        const cause =
          err instanceof TRPCError ? (err.cause ?? undefined) : undefined;
        if (cause instanceof PropertyValidationError) {
          try {
            logger.warn(
              { err, userId, profileSlug },
              "Entity creation failed validation — retrying same profile with properties dropped"
            );
            const salvaged = await entitiesCaller.create({
              profileSlug,
              title,
              properties: salvageProperties,
              documentId,
              source: "user",
              workspaceScoped: true,
            });
            entityId = (salvaged as { id: string }).id;
            propertiesDropped = true;
          } catch (retryErr) {
            // Same-profile retry still failed — last resort: fall back to note.
            logger.warn(
              { err: retryErr, userId, profileSlug },
              "Same-profile retry failed, falling back to note"
            );
            const fallback = await entitiesCaller.create({
              profileSlug: "note",
              title,
              properties: salvageProperties,
              documentId,
              source: "user",
              workspaceScoped: true,
            });
            entityId = (fallback as { id: string }).id;
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
          const fallback = await entitiesCaller.create({
            profileSlug: "note",
            title,
            properties: salvageProperties,
            documentId,
            source: "user",
            workspaceScoped: true,
          });
          entityId = (fallback as { id: string }).id;
          degradedFrom = originalProfileSlug;
          profileSlug = "note";
          mode = "fallback";
        }
      }

      logger.info(
        { userId, entityId, profileSlug, mode },
        "Thought captured and entity created"
      );

      return {
        success: true,
        entityId,
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
        // Optional extraction bias from the caller (e.g. the Discord bridge's
        // lead-capture channel: "this is a new-lead intake; prefer creating a
        // contact/company/lead; link to existing entities, don't duplicate").
        // Threaded verbatim into the IS structuring call. Absent → unchanged.
        instructions: z.string().max(2000).optional(),
        /**
         * Dedup strategy for `dedupCandidates`: "title" = existing Typesense
         * title-similarity search (unchanged); "semantic" = pgvector cosine
         * search over entity embeddings (see semanticDedupCandidates);
         * "both" (default) = run both and keep the MAX score per candidate.
         */
        dedupMode: z.enum(["title", "semantic", "both"]).default("both"),
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

      // 2. Fetch user's workspaces for routing hints (most-recently-updated
      // first, up to 30). The old `.limit(5)` had NO orderBy, so Postgres
      // returned an ARBITRARY 5 of the user's workspaces — a user with more
      // than five could have the correct destination (e.g. CRM) silently
      // dropped from the candidate set, making it unreachable to the router.
      const userWorkspaceRows = await database
        .select({
          id: workspaces.id,
          name: workspaces.name,
          description: workspaces.description,
          workspaceType: workspaces.workspaceType,
        })
        .from(workspaces)
        .innerJoin(
          workspaceMembers,
          eq(workspaceMembers.workspaceId, workspaces.id)
        )
        // Archived workspaces are retired — never a live routing destination.
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            isNull(workspaces.archivedAt)
          )
        )
        .orderBy(desc(workspaces.updatedAt))
        .limit(30);
      // Never surface non-user-data workspaces as routing candidates —
      // `operational` (system/admin) or `agent` (D2). Archived workspaces are
      // already excluded at the query level above (isNull(archivedAt)).
      const availableWorkspaces = userWorkspaceRows
        .filter((w) => isRoutableWorkspaceType(w.workspaceType))
        .map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description ?? undefined,
        }));

      // 2b. Fetch user's PROJECTS (cross-cutting lenses) for routing hints.
      // Scoping mirrors the Hub `/projects` list: pod-wide projects visible to
      // their owner; workspace-scoped projects visible to workspace members.
      const userProjectRows = await database
        .select({
          id: projects.id,
          name: projects.name,
          description: projects.description,
        })
        .from(projects)
        .where(
          and(
            or(
              and(isNull(projects.workspaceId), eq(projects.userId, userId)),
              and(
                isNotNull(projects.workspaceId),
                userVisibleWhere(projects.workspaceId, userId)
              )
            ),
            eq(projects.status, "active")
          )
        )
        .orderBy(desc(projects.createdAt))
        .limit(10);
      const availableProjects = userProjectRows.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? undefined,
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

      // Routing memory — recent corrections (negatives: the user moved the AI's
      // pick) + confirmed routes (positives) so the router learns from its own
      // history. Threaded into structure() so EVERY capture door benefits. Best
      // effort: a memory hiccup degrades to "no memory", never fails the capture.
      let routingMemory:
        | Awaited<ReturnType<typeof fetchRoutingMemory>>
        | undefined;
      try {
        routingMemory = await fetchRoutingMemory(userId);
      } catch (err) {
        logger.debug(
          { err, userId },
          "routing memory fetch failed (capture proceeds without it)"
        );
        routingMemory = undefined;
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
        followUp: null as string | StructuredFollowUp | null,
        targetWorkspaceId: null as string | null,
        targetProjectId: null as string | null,
        formSpec: null,
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

      const structureInput = {
        text: input.text ?? "",
        file: input.file,
        url: input.url,
        html: input.html,
        context: input.context,
        instructions: input.instructions,
        hints: {
          availableProfiles,
          availableWorkspaces,
          availableProjects,
          existingEntityNames,
          previousEntities: input.previousEntities,
          routingMemory,
        },
        timeoutMs: STRUCTURE_TIMEOUT_MS,
      };
      let structureResult: Awaited<ReturnType<typeof client.structure>>;
      try {
        const t0 = Date.now();
        structureResult = await client.structure(structureInput);
        // Retry once on a NULL — but ONLY a FAST null. The client returns null
        // both on a transient error/empty completion (worth a retry) AND on a
        // genuine timeout that burned the full budget. Retrying a timeout is the
        // worst case: a long input that crossed the budget will just cross it
        // again, doubling the wait to ~90s (and the LLM cost) for near-zero
        // gain. A fast null ⇒ transient (retry); a slow null ⇒ timeout (degrade).
        if (!structureResult) {
          const elapsedMs = Date.now() - t0;
          if (elapsedMs < STRUCTURE_TIMEOUT_MS * 0.7) {
            logger.warn(
              { userId, elapsedMs },
              "IS structure returned a fast null — retrying once before degrading"
            );
            structureResult = await client.structure(structureInput);
          } else {
            logger.warn(
              { userId, elapsedMs },
              "IS structure timed out (slow null) — degrading without retry"
            );
          }
        }
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

      // 1a. Reconcile the workspace pick by NAME. The LLM reliably reasons the
      // right workspace (its `targetWorkspaceReason`/`targetWorkspaceName` name
      // the correct one) but often copies the WRONG UUID from the list. Trust the
      // name it chose and resolve it to the real id from `availableWorkspaces`
      // (the list WE built), overriding an unreliable LLM UUID. No name / no match
      // → leave the LLM's id untouched.
      const pickedWsName = structureResult.targetWorkspaceName;
      const rawPickedWsId = structureResult.targetWorkspaceId;
      const reconciled = reconcileWorkspaceByName(
        pickedWsName,
        availableWorkspaces
      );
      if (reconciled) {
        structureResult.targetWorkspaceId = reconciled.resolvedWorkspaceId;
        // Derive confidence from reconciliation match STRENGTH when the model
        // didn't self-report one — so routing calibration + the auto-apply gate
        // work for EVERY agent (a BYOA agent that names a workspace but omits a
        // confidence would otherwise be dropped by the gate).
        if (structureResult.targetWorkspaceConfidence == null) {
          structureResult.targetWorkspaceConfidence =
            reconciled.derivedConfidence;
        }
        // Telemetry: reconciliation OVERRODE the LLM's raw id (a caught UUID-copy
        // error) — the exact win this name-resolution exists for.
        if (reconciled.resolvedWorkspaceId !== rawPickedWsId) {
          logger.info(
            {
              userId,
              pickedWsName,
              rawPickedWsId,
              resolvedWsId: reconciled.resolvedWorkspaceId,
              matchKind: reconciled.matchKind,
            },
            "Capture routing: name→id reconciliation overrode LLM UUID (copy-error caught)"
          );
        }
      } else if (!pickedWsName && rawPickedWsId) {
        // The IS emitted a raw targetWorkspaceId but NO targetWorkspaceName, so
        // name→id reconciliation can't run — the id is UNVERIFIABLE and might be
        // the LLM's copy-error (dogfooding caught exactly this: a null name + a
        // wrong id + a model confidence of 0.7 auto-filed a market signal into
        // the engineering workspace). Degrade the confidence below the gate so
        // an unverifiable pick degrades to ask/no-move instead of auto-applying.
        structureResult.targetWorkspaceConfidence = Math.min(
          structureResult.targetWorkspaceConfidence ?? 0,
          BELOW_GATE_CONFIDENCE
        );
        logger.warn(
          { userId, rawPickedWsId },
          "Capture routing: IS returned targetWorkspaceId without targetWorkspaceName — id unverifiable, confidence degraded below auto-apply gate"
        );
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

      // 1c. Resolver-driven routing (Wave 2). The ontology — the kinds/roles this
      // capture actually produced — is the AUTHORITATIVE placement signal, now
      // that the kinds are known (post-/structure). Run the one door and:
      //   • deterministic (rung 2/3/4): OVERRIDE the IS's catalog pick — the AI is
      //     not consulted when the role is enabled in exactly one of the caller's
      //     workspaces (the common case, R3).
      //   • ambiguous (rung-2 candidates >1): tie-break over ONLY those pre-approved
      //     candidates via the IS /api/workspace-tiebreak route (D3); abstain → stay
      //     put (never fall back to a full-catalog guess).
      //   • no ontology signal (rung 6, e.g. a pod-wide note/knowledge): keep the
      //     IS's name-reconciled pick from step 1a.
      // Best-effort: a resolver/tie-break hiccup leaves the step-1a pick untouched.
      const routingSlugs = Array.from(
        new Set(
          structureResult.entities
            .flatMap((e) => [
              e.profileSlug,
              ...(e.facets?.map((f) => f.profileSlug) ?? []),
            ])
            .filter((s): s is string => typeof s === "string" && s.length > 0)
        )
      );
      if (routingSlugs.length > 0) {
        try {
          const placement = await resolveWorkspacePlacement(database, {
            userId,
            kindSlug: routingSlugs[0],
            facetSlugs: routingSlugs.slice(1),
            ambientWorkspaceId: workspaceId,
          });
          const nameFor = (id: string | null | undefined) =>
            id
              ? (availableWorkspaces.find((w) => w.id === id)?.name ?? null)
              : null;
          if (placement.candidates.length > 1) {
            const tb = await client.workspaceTiebreak({
              content: inputText.slice(0, 4000),
              candidates: placement.candidates.map((c) => ({
                id: c.id,
                name: c.name,
              })),
              facetSlugs: routingSlugs,
            });
            if (tb?.workspaceId) {
              structureResult.targetWorkspaceId = tb.workspaceId;
              structureResult.targetWorkspaceName =
                placement.candidates.find((c) => c.id === tb.workspaceId)
                  ?.name ?? nameFor(tb.workspaceId);
              structureResult.targetWorkspaceReason =
                tb.reason ?? placement.reason;
              structureResult.targetWorkspaceConfidence = tb.confidence ?? null;
            } else {
              // Abstain (or tie-break unavailable) → don't move. Staying in the
              // ambient workspace is the honest choice over an arbitrary guess.
              structureResult.targetWorkspaceId = workspaceId;
              structureResult.targetWorkspaceName = nameFor(workspaceId);
              structureResult.targetWorkspaceConfidence = null;
              structureResult.targetWorkspaceReason =
                "workspace tie-break abstained — staying in the current workspace";
            }
          } else if (placement.rung <= 4 && placement.workspaceId) {
            // Deterministic ontology/context/relational hit — resolver decides.
            structureResult.targetWorkspaceId = placement.workspaceId;
            structureResult.targetWorkspaceName = nameFor(
              placement.workspaceId
            );
            structureResult.targetWorkspaceReason = placement.reason;
            structureResult.targetWorkspaceConfidence = placement.confidence;
          }
          // rung 6 → keep the step-1a IS pick (no ontology signal to override it).
        } catch (err) {
          logger.warn(
            { err, userId },
            "capture.structure: workspace resolver override failed — keeping IS pick"
          );
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
          targetWorkspaceName: structureResult.targetWorkspaceName ?? null,
          targetWorkspaceReason: structureResult.targetWorkspaceReason ?? null,
          targetWorkspaceConfidence:
            structureResult.targetWorkspaceConfidence ?? null,
          targetProjectId: structureResult.targetProjectId ?? null,
          targetProjectReason: structureResult.targetProjectReason ?? null,
          targetProjectConfidence:
            structureResult.targetProjectConfidence ?? null,
          formSpec: structureResult.formSpec ?? null,
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

      const dedupMode = input.dedupMode;
      const wantTitle = dedupMode === "title" || dedupMode === "both";
      const wantSemantic = dedupMode === "semantic" || dedupMode === "both";

      try {
        for (const entity of structureResult.entities) {
          if (!entity.title) continue;

          let titleCandidates: DedupCandidate[] = [];
          try {
            if (wantTitle) {
              const searchResult = await searchService.searchCollection(
                "entities",
                entity.title,
                { userId, workspaceId: workspaceId ?? undefined, limit: 3 }
              );

              // Score by honest title similarity, not Typesense's raw
              // text_match (see titleSimilarity doc comment above) — and drop
              // anything below the floor so fuzzy junk never reaches callers.
              titleCandidates = searchResult.results
                .filter((r) => r.document?.id !== undefined)
                .map((r) => ({
                  entityId: r.document.id as string,
                  title: (r.document.title as string) || "",
                  profileSlug: (r.document.entityType as string) || "note",
                  score: titleSimilarity(
                    entity.title,
                    (r.document.title as string) || ""
                  ),
                }))
                .filter((c) => c.score >= DEDUP_SIMILARITY_FLOOR);
            }
          } catch (err) {
            // Search failed for this entity — skip title dedup
            dedupSkipped = true;
            logger.warn(
              { err, userId, tempId: entity.tempId },
              "Title dedup search failed for entity — marking dedupSkipped"
            );
          }

          // Semantic dedup degrades independently (embed/pgvector unavailable
          // → empty list, never throws) so it never flips dedupSkipped on its
          // own — a title-only result stays "checked, no duplicates".
          const semanticCandidates: DedupCandidate[] = wantSemantic
            ? await semanticDedupCandidates(
                entity.title,
                (entity.properties as Record<string, unknown> | undefined)
                  ?.content as string | undefined,
                userId,
                workspaceId,
                3
              )
            : [];

          dedupCandidates[entity.tempId] = mergeDedupCandidates(
            titleCandidates,
            semanticCandidates
          );
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
        followUp: null as string | StructuredFollowUp | null,
        targetWorkspaceId: structureResult.targetWorkspaceId ?? null,
        targetWorkspaceName: structureResult.targetWorkspaceName ?? null,
        targetWorkspaceReason: structureResult.targetWorkspaceReason ?? null,
        targetWorkspaceConfidence:
          structureResult.targetWorkspaceConfidence ?? null,
        targetProjectId: structureResult.targetProjectId ?? null,
        targetProjectReason: structureResult.targetProjectReason ?? null,
        targetProjectConfidence:
          structureResult.targetProjectConfidence ?? null,
        formSpec: structureResult.formSpec ?? null,
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
            /**
             * Kind + Facets: role-profiles to attach to this entity once it
             * materializes (or onto its dedup match). `contextTempId` references
             * another entity in this same batch by `tempId` (the disambiguating
             * context) — resolved to the real created/matched id after
             * materialization. Attached through the governed `attachFacet` door;
             * an unknown role slug is skipped + logged, never fails the capture.
             */
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
        /**
         * Workspace routing mode (shared across all doors). Applied ONLY when the
         * caller passes the AI's routing hints (`aiWorkspaceId`) AND does NOT pass
         * a direct `targetWorkspaceId` override. Default: "auto".
         */
        workspaceRouting: z.enum(["auto", "ask", "locked"]).optional(),
        /** The AI-resolved target workspace (from /capture/structure). */
        aiWorkspaceId: z.string().uuid().nullish(),
        /** Confidence (0..1) in the AI's workspace pick — gates AUTO moves. */
        aiWorkspaceConfidence: z.number().nullish(),
        /** One-line justification for the AI's workspace pick (surfaced in ASK). */
        aiWorkspaceReason: z.string().nullish(),
        /**
         * Active focus session (from the `X-Session-Id` header). When set, every
         * captured entity is linked to it via `session --produced--> entity` —
         * the SAME edge the entities router emits inline. This is what scopes
         * captures to an event in "event mode". Optional / back-compat.
         */
        sessionId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const database = await getDb();
      // Workspace placement — THE one door (WorkspaceResolutionService, I1). A
      // direct `targetWorkspaceId` override always wins (rung 1: a caller that
      // already resolved the workspace). Otherwise, when the caller forwards the
      // AI's routing hints, the door's rung-5 tie-break applies auto/ask/locked
      // exactly as the old inline gate did, so every door (MCP, REST, CLI,
      // Raycast, import) routes identically. No hints → today's ambient behavior.
      let workspaceId: string | null | undefined;
      let routing: CaptureRoutingResult | undefined;
      let placementRung: ResolutionRung | undefined;
      let placementReason: string | undefined;
      if (input.targetWorkspaceId) {
        workspaceId = input.targetWorkspaceId;
      } else if (input.aiWorkspaceId && ctx.workspaceId) {
        const mode = input.workspaceRouting ?? "auto";
        // Auto-tune the gate per TARGET workspace from its correction history —
        // only when a move is actually on the table (auto mode, different
        // workspace), keeping the extra read off the common in-place case.
        // Best-effort: a tuning-query hiccup falls back to the flat gate.
        let minConfidence: number | undefined;
        if (mode === "auto" && input.aiWorkspaceId !== ctx.workspaceId) {
          minConfidence = await fetchWorkspaceRoutingThreshold(
            userId,
            input.aiWorkspaceId
          ).catch(() => undefined);
        }
        const placement = await resolveWorkspacePlacement(database, {
          userId,
          ambientWorkspaceId: ctx.workspaceId,
          aiHint: {
            workspaceId: input.aiWorkspaceId,
            confidence: input.aiWorkspaceConfidence,
            reason: input.aiWorkspaceReason,
          },
          mode,
          minConfidence,
        });
        workspaceId = placement.workspaceId;
        placementRung = placement.rung;
        placementReason = placement.reason;
        // Map the door decision back to the surface's routing shape (movedTo /
        // pendingWorkspaceSwitch) the response + telemetry already consume.
        if (placement.ask) {
          routing = {
            workspaceId: placement.workspaceId ?? ctx.workspaceId,
            pendingWorkspaceSwitch: {
              suggestedWorkspaceId:
                placement.candidates[0]?.id ?? input.aiWorkspaceId,
              reason: input.aiWorkspaceReason ?? null,
              confidence: input.aiWorkspaceConfidence ?? null,
            },
          };
        } else if (
          placement.rung === 5 &&
          placement.workspaceId &&
          placement.workspaceId !== ctx.workspaceId
        ) {
          routing = {
            workspaceId: placement.workspaceId,
            movedToWorkspace: placement.workspaceId,
          };
        } else {
          routing = { workspaceId: placement.workspaceId ?? ctx.workspaceId };
        }
      } else {
        workspaceId = ctx.workspaceId;
      }
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const entityRepo = new EntityRepository(database, eventRepo);
      const relationRepo = new RelationRepository(database, eventRepo);
      const entitiesCaller = entitiesRouter.createCaller(
        ctx as unknown as Context
      );

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

      // Kind + Facets guard (T2): a payload whose profileSlug is itself a ROLE
      // (client/partner/…) must never become a role-named entity — the role is
      // a facet on a real subject. Rewrite each such payload to (kind + facet):
      // carry the role as a facet and set the entity's kind to the role's single
      // applicable kind. When the kind is ambiguous/underivable, only proceed
      // onto an existing subject (link + attach the role via strong match); else
      // leave it unchanged + log — never invent a kind. The strong-match loop
      // below then links/creates, and the facet-attach pass materializes roles.
      for (const e of input.entities) {
        if (e.existingEntityId) continue;
        const rolePayload = await resolveRolePayload(database, e.profileSlug);
        if (!rolePayload) continue;
        const roleFacet = {
          profileSlug: rolePayload.slug,
          properties: e.properties,
        };
        if (rolePayload.applicableKinds.length === 1) {
          e.facets = [roleFacet, ...(e.facets ?? [])];
          e.profileSlug = rolePayload.applicableKinds[0];
        } else {
          const identity = await resolveIdentity(database, {
            userId,
            name: e.title,
            signals: extractIdentitySignals(e.properties),
            userScope: userVisibleWhere(entitiesTable.workspaceId, userId),
            limit: 5,
          });
          if (identity.match === "strong" && identity.entity) {
            e.existingEntityId = identity.entity.id;
            e.facets = [roleFacet, ...(e.facets ?? [])];
          } else {
            logger.warn(
              { roleSlug: e.profileSlug, tempId: e.tempId },
              "capture.execute: role-slug payload has no single applicable kind and no identity match — creating as-is (fallback)"
            );
          }
        }
      }

      // Identity-first: for each entity op that doesn't already name an
      // explicit existingEntityId, check the identity resolver. A STRONG
      // signal match (email/phone/url/…) means the subject already exists —
      // merge new non-empty properties into it and link via `existingEntityId`
      // (the SAME path a caller-supplied link takes below) instead of creating
      // a duplicate. WEAK matches are advisory only; capture must stay
      // zero-friction, so they proceed to create.
      const autoLinkedTempIds = new Set<string>();
      const resolvedExistingIds = new Map<string, string>();
      for (const e of input.entities) {
        if (e.existingEntityId) continue;
        const identity = await resolveIdentity(database, {
          userId,
          kindSlug: e.profileSlug,
          name: e.title,
          signals: extractIdentitySignals(e.properties),
          userScope: userVisibleWhere(entitiesTable.workspaceId, userId),
          limit: 5,
        });
        if (identity.match !== "strong" || !identity.entity) continue;
        const nonEmptyProperties = Object.fromEntries(
          Object.entries(e.properties ?? {}).filter(
            ([, v]) => v !== undefined && v !== null && v !== ""
          )
        );
        if (Object.keys(nonEmptyProperties).length > 0) {
          try {
            await entitiesCaller.update({
              id: identity.entity.id,
              properties: nonEmptyProperties,
              source: "user",
            });
          } catch (err) {
            logger.warn(
              { err, entityId: identity.entity.id },
              "capture.execute: identity-match enrich failed (linking anyway)"
            );
          }
        }
        resolvedExistingIds.set(e.tempId, identity.entity.id);
        autoLinkedTempIds.add(e.tempId);
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
          existingEntityId:
            e.existingEntityId ?? resolvedExistingIds.get(e.tempId),
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
      // returning the ACTUAL profile created so the response reflects
      // fallbacks. Routes through the main entity door (entities.create),
      // never entityRepo.create directly, so capture gets the same
      // project-linking, session `produced` links, property→relation sync,
      // identity-signal registration, and emit chain every other creator gets.
      // Routing W1 (decision D3): identity is pod-wide, role hats live in
      // lenses. A pod-scope kind (person/company/… — entityScope='pod') is
      // created POD-WIDE (workspaceId=null) instead of force-stamped into the
      // routed workspace; the routed workspace instead becomes the workspaceId
      // of its ATTACHED FACETS (below). Workspace-scoped kinds (task/note/item/
      // deal/event…) keep the routed stamp — their documents/sessions/projects
      // link via the entity's workspaceId (load-bearing; do not break). Cache
      // per slug so a batch of many same-kind entities resolves scope once.
      const scopeService = new ProfileResolutionService(database);
      const entityScopeCache = new Map<string, "pod" | "workspace">();
      const isPodScopeProfile = async (slug: string): Promise<boolean> => {
        const cached = entityScopeCache.get(slug);
        if (cached) return cached === "pod";
        const scope = await scopeService.getEntityScope(
          slug,
          workspaceId ?? null
        );
        entityScopeCache.set(slug, scope);
        return scope === "pod";
      };

      const entityCaller = {
        create: async (op: {
          profileSlug: string;
          title?: string;
          description?: string;
          properties?: Record<string, unknown>;
          content?: string;
        }) => {
          // Pod-scope kinds land pod-wide (null workspace); workspace-scope
          // kinds keep the routed stamp. The note fallback below is always a
          // workspace kind, so it always keeps the routed stamp.
          const isPod = await isPodScopeProfile(op.profileSlug);
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
            const created = await entitiesCaller.create({
              profileSlug: op.profileSlug,
              title: op.title,
              description: op.description,
              properties,
              documentId,
              source: "user",
              // Pod-scope kind → pod-wide (null workspace): omit the routed
              // stamp and let the profile's pod-default win. Workspace-scope
              // kind → pin to the ROUTED workspace so the entity doesn't split
              // from its document/project/session links (which use workspaceId).
              targetWorkspaceId: isPod ? undefined : (workspaceId ?? undefined),
              workspaceScoped: !isPod,
            });
            return {
              id: (created as { id: string }).id,
              profileSlug: op.profileSlug,
            };
          } catch (err) {
            // PropertyValidationError = valid profile, invalid property. Salvage
            // the typed profile by retrying ONCE with the same slug, properties
            // stripped, before falling back to note. The door wraps the original
            // error in a TRPCError; the original is preserved as `.cause`.
            const cause =
              err instanceof TRPCError ? (err.cause ?? undefined) : undefined;
            if (cause instanceof PropertyValidationError) {
              try {
                logger.warn(
                  { err, profileSlug: op.profileSlug },
                  "Entity creation failed validation — retrying same profile with properties dropped"
                );
                const salvaged = await entitiesCaller.create({
                  profileSlug: op.profileSlug,
                  title: op.title,
                  description: op.description,
                  properties: salvageProperties,
                  documentId,
                  source: "user",
                  targetWorkspaceId: isPod
                    ? undefined
                    : (workspaceId ?? undefined),
                  workspaceScoped: !isPod,
                });
                return {
                  id: (salvaged as { id: string }).id,
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
            const fallback = await entitiesCaller.create({
              profileSlug: "note",
              title: op.title,
              description: op.description,
              properties: salvageProperties,
              documentId,
              source: "user",
              targetWorkspaceId: workspaceId ?? undefined,
              workspaceScoped: true,
            });
            return {
              id: (fallback as { id: string }).id,
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
        // Additive: true when this op auto-linked onto an existing entity via
        // a strong identity match (email/phone/url/…) instead of the caller's
        // own `existingEntityId`.
        ...(autoLinkedTempIds.has(e.ref ?? "")
          ? { deduplicated: true as const }
          : {}),
      }));
      const createdRelations = result.relations.map((r) => ({
        sourceEntityId: r.sourceEntityId,
        targetEntityId: r.targetEntityId,
        relationType: r.type,
      }));

      // Kind + Facets: attach each entity's proposed role-profiles now that the
      // batch has materialized (created OR dedup-matched — both carry a real id).
      // Goes through the SAME governed door submit-capture-graph's approve flow
      // uses (entities.attachFacet → FacetRepository.attach): the ONE facet write
      // door, so validation + the emit chain are inherited. `contextTempId`
      // resolves against THIS batch's tempId→id map (the disambiguating context
      // entity). Best-effort per role: an unknown/misapplied role slug is skipped
      // + logged (never fails the capture); attach is idempotent (unique index).
      const tempIdToEntityId = new Map(
        created.map((c) => [c.tempId, c.entityId])
      );
      let facetsAttached = 0;
      for (const e of input.entities) {
        if (!e.facets?.length) continue;
        const parentEntityId = tempIdToEntityId.get(e.tempId);
        if (!parentEntityId) continue;
        for (const f of e.facets) {
          const contextEntityId = f.contextTempId
            ? tempIdToEntityId.get(f.contextTempId)
            : undefined;
          try {
            await entitiesCaller.attachFacet({
              entityId: parentEntityId,
              profileSlug: f.profileSlug,
              properties: f.properties,
              status: f.status,
              contextEntityId,
              // Routing W1: role hats live in the routed lens. Pin the facet to
              // the routed workspace (the entity itself may be pod-wide). Null/
              // undefined routed ws → inherit the parent (pod-wide facet).
              workspaceId: workspaceId ?? undefined,
              source: "user",
            });
            facetsAttached++;
          } catch (err) {
            logger.warn(
              { err, entityId: parentEntityId, roleSlug: f.profileSlug },
              "capture.execute: facet attach skipped (unknown/misapplied role or attach failure)"
            );
          }
        }
      }

      // Project membership (lens-context): file the captured entities into the
      // active project. Capture materializes directly (not via proposal
      // approval), so the membership write lands here — the project mirror of
      // how `workspaceId` is stamped on the entity. Idempotent, best-effort.
      if (input.projectId) {
        // Link ALL captured entities — fresh AND dedup-merged. If you capture
        // something into a project and it merges into an existing entity, that
        // entity now belongs to the project too (linkEntityToProject is
        // idempotent + best-effort, so re-linking an existing member is a no-op).
        const entityIdsToLink = created.map((c) => c.entityId);
        for (const entityId of entityIdsToLink) {
          await linkEntityToProject(database, {
            entityId,
            projectId: input.projectId,
            userId,
            workspaceId: workspaceId ?? null,
          });
        }
      }

      // Event/session scoping (event mode): when a focus session is active
      // (X-Session-Id), link EVERY captured entity to it via
      // `session --produced--> entity`. entities.create (the door capture
      // materializes through) already emits this for freshly-created entities
      // when ctx.sessionId is set — idempotent, so that's a no-op re-insert
      // here — but it does NOT cover entities that were LINKED (existing or
      // identity-deduped) rather than created, so this explicit pass is still
      // required to cover the full `created` set. Idempotent via the links
      // unique-edge index; best-effort (never blocks the capture).
      if (input.sessionId) {
        for (const c of created) {
          try {
            await database
              .insert(links)
              .values({
                workspaceId: workspaceId ?? null,
                fromType: "session" as LinkEndpointType,
                fromId: input.sessionId,
                toType: "entity" as LinkEndpointType,
                toId: c.entityId,
                linkType: "produced" as LinkType,
                metadata: {},
              })
              .onConflictDoNothing();
          } catch (err) {
            logger.warn(
              { err, sessionId: input.sessionId, entityId: c.entityId },
              "capture: session-produced link failed (non-fatal)"
            );
          }
        }
      }

      logger.info(
        {
          userId,
          entitiesCreated: created.filter((c) => !c.linked).length,
          entitiesLinked: created.filter((c) => c.linked).length,
          relationsCreated: createdRelations.length,
          facetsAttached,
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
          const { correlationId, proposal } = await createAutoApprovedProposal({
            userId,
            reviewedBy: userId,
            workspaceId: workspaceId ?? null,
            projectId: input.projectId ?? null,
            targetType: "entity",
            targetId: randomUUID(),
            proposalType: "capture.graph",
            action: "graph",
            // Event source must be a valid EventSource (api/automation/system/…);
            // "capture" is NOT one — passing it made every capture audit event
            // fail Zod validation (silently, via best-effort auditLog). The
            // capture-origin discriminator already lives in data.source + the
            // proposalType, so the transport source is "api".
            source: "api",
            summary: buildCaptureSummary(operations),
            data: {
              operations,
              source: "capture",
              materialized: { entityIds: materializedEntityIds },
            },
          });

          // A routing decision is only MEASURABLE when it (a) actually made a
          // pick (aiWorkspaceId) AND (b) produced at least one fresh entity to
          // stamp — otherwise there is nothing a later correction could move,
          // so scoring it would inflate accuracy with an unfalsifiable "win".
          // Gate the decision emit AND the correlationId stamp on the SAME
          // condition so decisions↔stamps stay 1:1 (no phantom decision on an
          // all-deduped capture; no orphan correlationId on a non-AI capture
          // whose later mutations would emit corrections matching no decision).
          const routingDecisionRecorded =
            Boolean(input.aiWorkspaceId) && materializedEntityIds.length > 0;

          // Provenance stamp — join the created entities back to the decision
          // that produced them (shared correlationId, only when a decision was
          // recorded) and the proposal that recorded the write (always, for
          // traceability), so a future feedback bridge can score AI decision
          // quality by correlationId. BEST-EFFORT: never fail the capture over
          // a stamping hiccup.
          if (materializedEntityIds.length > 0) {
            try {
              const stamped = await database
                .update(entitiesTable)
                .set({
                  correlationId: routingDecisionRecorded ? correlationId : null,
                  sourceProposalId: proposal?.id ?? null,
                })
                .where(inArray(entitiesTable.id, materializedEntityIds))
                .returning({ id: entitiesTable.id });
              logger.debug(
                {
                  correlationId,
                  requested: materializedEntityIds.length,
                  stamped: stamped.length,
                },
                "Track 3: entity provenance stamped"
              );
            } catch (err) {
              logger.warn(
                { err, userId, correlationId },
                "Track 3: entity provenance stamp failed (capture preserved)"
              );
            }
          }

          // Observability flywheel foundation — record the workspace-routing
          // decision as its own event, sharing the proposal's correlationId so
          // the decision, the proposal, and the materialized entities can all
          // be joined by a future feedback bridge. Only emitted when a routing
          // decision was actually in play (an AI workspace hint was supplied).
          // subjectType/action are OUTSIDE the closed SubjectType/EventAction
          // unions (auditLog's own opts type is plain `string`, and the events
          // table column is untyped text — see audit-log.ts) — the discriminator
          // also lives in `data.kind` for any consumer that DOES enforce those
          // unions downstream. Gated on `routingDecisionRecorded` (see above)
          // so every emitted decision has ≥1 stamped entity to be corrected
          // against — keeping the decision↔correction join 1:1.
          if (routingDecisionRecorded) {
            await emitAiDecision({
              action: "route",
              userId,
              workspaceId: workspaceId ?? null,
              correlationId,
              data: {
                kind: AI_KIND.ROUTE,
                chosenWorkspaceId: routing?.movedToWorkspace ?? workspaceId,
                confidence: input.aiWorkspaceConfidence ?? null,
                reason: input.aiWorkspaceReason ?? null,
                // I6: which ladder rung decided + its code-generated reason
                // (additive — dashboards can now attribute a route to a rung).
                rung: placementRung ?? null,
                routeReason: placementReason ?? null,
                mode: input.workspaceRouting ?? "auto",
                applied: Boolean(routing?.movedToWorkspace),
                currentWorkspaceId: ctx.workspaceId,
              },
            });
          }
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

      return {
        created,
        relations: createdRelations,
        // Routing outcome (present only when routing engaged) — the surface can
        // show "moved to X" / offer to confirm a suggested switch.
        ...(routing?.movedToWorkspace
          ? { movedToWorkspace: routing.movedToWorkspace }
          : {}),
        ...(routing?.pendingWorkspaceSwitch
          ? { pendingWorkspaceSwitch: routing.pendingWorkspaceSwitch }
          : {}),
      };
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
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
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
