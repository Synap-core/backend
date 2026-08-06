import { randomUUID } from "crypto";
import {
  getDb,
  ProfileResolutionService,
  PropertyValidationService,
  KnowledgeFormConflictError,
  normalizeKnowledgeProperties,
  resolveKindWritePin,
  eq,
  workspaces,
  workspaceMembers,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  buildAvailableProfiles,
  withEffectiveProperties,
  type AccessibleProfileLike,
} from "../../routers/capture.js";
import {
  adaptItems,
  parseCsvTable,
  csvRowsToTypedImportItems,
  type ImportSource as ImportAdapterSource,
  type CsvTablePlan,
} from "../../import/import-adapters.js";
import {
  buildImportProposal,
  importProposalToComposite,
  type ImportItem,
} from "../../import/import-items.js";
import { aiEnrichImportItems } from "../../import/import-ai.js";
import {
  deepStructureImportItems,
  makeGraphResolver,
} from "../../import/import-deep.js";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";
import { searchService } from "@synap/search";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { createEventBackedProposal } from "../../utils/event-backed-proposal.js";
import type { OrchestratorContext } from "./types.js";

const logger = createLogger({ module: "import-orchestrator/structuring" });

/**
 * Build a human-readable proposal summary from composite import operations by
 * extracting entity titles — the same pattern as `buildCaptureSummary` in
 * capture.ts. Centralised, extendable: any new importer feeds the same helper.
 */
export function buildImportSummary(
  operations: ReadonlyArray<{ op?: unknown; title?: unknown }>,
  source?: string
): string {
  const titles: string[] = [];
  for (const op of operations) {
    if (op.op === "create_entity" && typeof op.title === "string") {
      titles.push(op.title);
    }
  }
  const prefix = source ? `${source} import` : "Import";
  if (titles.length === 0) return prefix;
  if (titles.length === 1) return `${prefix}: ${titles[0]}`;
  if (titles.length === 2) return `${prefix}: ${titles[0]}, ${titles[1]}`;
  return `${prefix}: ${titles[0]}, ${titles[1]}, +${titles.length - 2} more`;
}

/**
 * Per-op homes summary for an import graph — how create_entity ops are
 * distributed across workspaces / projects. Consumed by analyze/analyzeLarge
 * return payloads so the client can render multi-home placement before apply.
 */
export type ImportHomesSummary = {
  /** targetWorkspaceId → create_entity count */
  byWorkspace: Record<string, number>;
  /** create_entity ops with no targetWorkspaceId (pod-wide) */
  podWide: number;
  /** projectId → create_entity count */
  byProject: Record<string, number>;
  /**
   * True when the graph spans more than one home:
   * >1 distinct workspace pins, OR mix of pod-wide + at least one pin.
   */
  multiHome: boolean;
};

/**
 * Tally create_entity ops into a homes summary. Pure / side-effect free.
 */
export function computeImportHomes(
  operations: ReadonlyArray<CompositeProposalOperation>
): ImportHomesSummary {
  const byWorkspace: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  let podWide = 0;
  for (const op of operations) {
    if (op.op !== "create_entity") continue;
    const ws = op.targetWorkspaceId;
    if (typeof ws === "string" && ws.length > 0) {
      byWorkspace[ws] = (byWorkspace[ws] ?? 0) + 1;
    } else {
      podWide++;
    }
    const projectId = op.projectId;
    if (typeof projectId === "string" && projectId.length > 0) {
      byProject[projectId] = (byProject[projectId] ?? 0) + 1;
    }
  }
  const workspaceKeys = Object.keys(byWorkspace);
  const multiHome =
    workspaceKeys.length > 1 || (podWide > 0 && workspaceKeys.length > 0);
  return { byWorkspace, podWide, byProject, multiHome };
}

/**
 * Majority targetWorkspaceId among create_entity pins (highest count wins;
 * ties break by first-seen insertion order of Object.keys). Null when no pins.
 */
export function majorityWorkspaceFromHomes(
  homes: ImportHomesSummary
): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of Object.entries(homes.byWorkspace)) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

/**
 * Stamp a graph's process home onto **workspace-scoped** create_entity ops only.
 *
 * THE one home-stamp for import + capture graphs (parity). Pod-scope kinds
 * (person, company, knowledge, …) stay unpinned so materialize leaves them
 * pod-wide; role facets carry domain visibility. Does NOT overwrite existing
 * per-op `targetWorkspaceId` pins (multi-home import paths).
 *
 * Uses {@link resolveKindWritePin} so create doors and graph stamps share ONE rule.
 */
export async function stampScopeAwareHomesOnOps(
  operations: CompositeProposalOperation[],
  graphWorkspaceId: string | null | undefined,
  getEntityScope: (profileSlug: string) => Promise<"pod" | "workspace">
): Promise<void> {
  if (!graphWorkspaceId) return;
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (op.op !== "create_entity") continue;
    if (op.targetWorkspaceId) continue;
    if (op.existingEntityId) continue;
    const entityScope = await getEntityScope(op.profileSlug);
    const pin = resolveKindWritePin({
      entityScope,
      routedWorkspaceId: graphWorkspaceId,
    });
    if (pin.targetWorkspaceId) {
      operations[i] = { ...op, targetWorkspaceId: pin.targetWorkspaceId };
    }
  }
}

/**
 * The `data` payload for an `import.graph` proposal. Centralised so the three
 * proposal-creation sites (submitBatch / analyze / analyzeLarge) cannot drift —
 * a new provenance field is added ONCE, here. These keys are read by
 * `buildRequestFromProposal` → the proposal review UI:
 *   source     — where it came from
 *   sourceId   — stable id of this import unit (batchId, else the proposal target)
 *   contentRef — object-storage location of the raw uploaded blob, when one exists
 *   reasoning  — human-readable justification, when a producer has one
 */
export function buildImportGraphProposalData(input: {
  operations: CompositeProposalOperation[];
  source: string;
  sourceId: string;
  contentRef?: { storageKey: string; mimeType?: string; size?: number };
  reasoning?: string;
  /** Continuous-improvement report (refuse → inspect → re-run → apply). */
  quality?: unknown;
  homes?: unknown;
  corpusMap?: unknown;
}): Record<string, unknown> {
  return {
    operations: input.operations,
    source: input.source,
    sourceId: input.sourceId,
    ...(input.contentRef ? { contentRef: input.contentRef } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.homes ? { homes: input.homes } : {}),
    ...(input.corpusMap ? { corpusMap: input.corpusMap } : {}),
  };
}

/**
 * The target workspace's REAL profiles → typed hints for the structuring model +
 * the allow-list of slugs assignable as a type, plus the user's workspaces.
 */
export type ProfileHints = {
  availableProfiles: ReturnType<typeof buildAvailableProfiles>;
  validSlugs: Set<string>;
  availableWorkspaces: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  /**
   * Preflight against the REAL profile schema. Deep structuring calls this for
   * every entity it is about to emit as a `create_entity` op; an op that would
   * fail `EntityRepository.create`'s required-property validation at apply is
   * degraded to a `note` (title + body preserved) instead of being queued as a
   * hollow shell that hard-fails the whole proposal. Never a hardcoded list —
   * this is `getEffectiveProperties` through the same door the materializer uses.
   */
  validateEntity: EntitySchemaValidator;
};

/**
 * Validate the properties an extracted entity would materialize with, against
 * the profile's effective schema in this workspace lens.
 * Returns `{ valid: true }` for an unknown slug (typing is gated separately by
 * `validSlugs`) and for any resolution failure — this gate must never REJECT
 * more than the materializer would.
 */
export type EntitySchemaValidator = (input: {
  profileSlug: string;
  title?: string;
  properties?: Record<string, unknown>;
  content?: string;
}) => Promise<{ valid: boolean; errors: string[] }>;

/**
 * Build the preflight validator over a live `ProfileResolutionService`.
 * Mirrors `submit-capture-graph.ts`'s PREFLIGHT block (the capture-graph twin of
 * this gate): same `validateEntityCreateForProposal` door, same `content`
 * folding, same profile-defaults merge — so import and capture agree on what
 * "materializable" means. Per-profile resolution is memoized for the batch.
 */
export function makeEntitySchemaValidator(
  profileService: ProfileResolutionService,
  propertyValidation: PropertyValidationService,
  ctx: { userId: string; workspaceId: string | null }
): EntitySchemaValidator {
  const profileMemo = new Map<
    string,
    Promise<{ id: string; defaultValues: Record<string, unknown> } | null>
  >();
  const resolve = (slug: string) => {
    let hit = profileMemo.get(slug);
    if (!hit) {
      hit = profileService
        .resolveProfile(slug, ctx.userId, ctx.workspaceId)
        .then((p) =>
          p
            ? {
                id: p.id,
                defaultValues:
                  (p.defaultValues as Record<string, unknown>) ?? {},
              }
            : null
        )
        .catch(() => null);
      profileMemo.set(slug, hit);
    }
    return hit;
  };

  return async ({ profileSlug, title, properties, content }) => {
    const profile = await resolve(profileSlug);
    // Unknown profile ⇒ nothing to validate against. Slug typing is already
    // gated by `validSlugs`; failing open here keeps this gate no stricter than
    // the materializer.
    if (!profile) return { valid: true, errors: [] };
    let propsToCheck: Record<string, unknown> = { ...(properties ?? {}) };
    if (profileSlug === "knowledge") {
      try {
        propsToCheck = normalizeKnowledgeProperties(propsToCheck);
      } catch (error) {
        if (error instanceof KnowledgeFormConflictError) {
          return { valid: false, errors: [error.message] };
        }
        throw error;
      }
    }
    // A body materializes as a linked document / inline `content` property —
    // fold it in exactly as the materializer does so a profile that REQUIRES
    // `content` isn't falsely flagged when prose was supplied.
    if (content) propsToCheck.content = content;
    try {
      return await propertyValidation.validateEntityCreateForProposal(
        propsToCheck,
        profile.id,
        ctx.workspaceId,
        {
          ...(title !== undefined ? { title } : {}),
          profileDefaults: profile.defaultValues,
        }
      );
    } catch (err) {
      logger.warn(
        { err, profileSlug },
        "import preflight: property validation threw — treating entity as valid (no stricter than materialize)"
      );
      return { valid: true, errors: [] };
    }
  };
}

/**
 * Resolve the target workspace's REAL profiles → typed hints for the
 * structuring model + the allow-list of slugs assignable as a type. Same
 * resolution rest/capture.ts uses for /import/analyze + /import/apply. The
 * caller (ImportOrchestrator) memoizes the result per-batch.
 */
export async function resolveProfileHints(
  ctx: OrchestratorContext
): Promise<ProfileHints> {
  const { workspaceId, userId } = ctx;
  const db2 = await getDb();
  const profileService = new ProfileResolutionService(db2);
  const accessible = await profileService.getAccessibleProfiles(
    userId,
    workspaceId
  );
  // The REAL property schema per profile — without this the structuring model
  // is told the slugs but not the properties, and returns titles with
  // `properties: {}` (hollow entities). See `withEffectiveProperties`.
  const availableProfiles = buildAvailableProfiles(
    await withEffectiveProperties(
      profileService,
      accessible as unknown as AccessibleProfileLike[],
      workspaceId
    )
  );
  // The user's workspaces — lets the structuring model suggest where notes belong.
  const wsRows = await db2
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
    .limit(8);
  return {
    availableProfiles,
    validSlugs: new Set(availableProfiles.map((p) => p.slug)),
    availableWorkspaces: wsRows.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description ?? undefined,
    })),
    validateEntity: makeEntitySchemaValidator(
      profileService,
      new PropertyValidationService(profileService),
      { userId, workspaceId: workspaceId ?? null }
    ),
  };
}

/**
 * Derive a TABLE-aware plan for a CSV import: ONE profile for the whole table
 * + a column→property routing plan, via the IS `analyze-bulk-mapping`
 * capability (the SAME endpoint capture.analyzeBulkMapping drives). The
 * inferred profile is gated against the workspace's real `validSlugs` so a
 * recognized profile (e.g. `person`) sticks and an unknown one falls back to
 * `note`. Returns null when the IS is unreachable / returns no plan — the
 * caller then keeps the existing shallow CSV behavior.
 *
 * Best-effort + non-destructive: a CSV import never fails because the planner
 * is down; it degrades to the prior shallow path.
 */
export async function buildCsvTablePlan(
  ctx: OrchestratorContext,
  rawCsv: string,
  validSlugs: Set<string>,
  availableProfiles: ReturnType<typeof buildAvailableProfiles>
): Promise<CsvTablePlan | null> {
  const { headers, sampleRows } = parseCsvTable(rawCsv);
  if (headers.length === 0 || sampleRows.length === 0) return null;

  const { workspaceId, userId } = ctx;
  const wsId = workspaceId ?? undefined;
  try {
    const { client } = await resolveIntelligenceService({
      userId,
      workspaceId: wsId,
      capability: "default",
    });
    const plan = await client.analyzeBulkMapping({
      headers,
      sampleRows,
      intent: "Import this CSV table as typed entities (one row = one entity).",
      availableProfiles,
    });
    if (!plan) return null;

    // Gate the inferred profile against the workspace's real slugs — an
    // unknown slug would fail profile validation on create and dump the row
    // back to a bare note, dropping its properties. Fall back to `note`.
    const inferred = (plan.rowEntityType ?? "").trim().toLowerCase();
    const profileSlug = validSlugs.has(inferred) ? inferred : "note";

    return {
      profileSlug,
      titleColumn: plan.titleColumn ?? null,
      columns: plan.columnMappings.map((c) => ({
        header: c.header,
        slug: c.slug,
        valueType: c.valueType,
        scope: c.scope,
      })),
    };
  } catch (e) {
    logger.warn(
      { e, userId, workspaceId },
      "import buildCsvTablePlan failed — falling back to shallow CSV"
    );
    return null;
  }
}

/**
 * Route a parsed source through the canonical import ENGINE: adapt raw records
 * → ImportItems → (best-effort AI structuring) → buildImportProposal →
 * importProposalToComposite → ONE governed `import.graph` composite proposal.
 *
 * This replaces the old per-row entity-proposal loop: a whole file (or batch
 * of files) for a source becomes a SINGLE reviewable graph proposal that, on
 * approval, materializes N entities + M relations atomically and (because the
 * proposal is workspace-bound) workspace-scoped via proposals.approve.
 *
 * AI enrichment is on by default and best-effort: any IS failure falls back to
 * the deterministic proposal (items unchanged). Returns the created proposal id
 * or null when the source produced no items. The caller resolves + memoizes the
 * `profileHints` (singular per-batch) and passes them in.
 */
export async function proposeImportGraph(
  ctx: OrchestratorContext,
  profileHints: ProfileHints,
  source: ImportAdapterSource,
  raw: Array<{ path: string; content: string }>,
  provenance?: {
    /** Stable id for this import unit (batchId) — used as `data.sourceId`. */
    sourceId?: string;
    /** Object-storage location of the raw uploaded blob, if any. */
    contentRef?: { storageKey: string; mimeType?: string; size?: number };
  }
): Promise<{ proposalId: string | null; itemCount: number }> {
  const { workspaceId, userId } = ctx;
  // IS routing + the live-search resolver take an optional workspaceId; a
  // pod-wide import (null) resolves the user-default service and an
  // unscoped search.
  const wsId = workspaceId ?? undefined;

  const { availableProfiles, validSlugs, availableWorkspaces } = profileHints;

  // CSV is a TABLE: infer ONE profile + column→property mapping for the whole
  // file and build TYPED items, instead of the shallow row→untyped-note path.
  // Best-effort — if the planner is unavailable, `items` stays empty here and
  // we fall through to the shallow adapter below.
  let items: ImportItem[] = [];
  if (source === "csv" && raw.length > 0) {
    // Infer the plan from the first file (submitBatch sends one CSV per call);
    // apply it to every file's rows.
    const plan = await buildCsvTablePlan(
      ctx,
      raw[0].content,
      validSlugs,
      availableProfiles
    );
    if (plan) {
      for (const r of raw) {
        const { rows } = parseCsvTable(r.content);
        items.push(...csvRowsToTypedImportItems(rows, plan));
      }
    }
  }
  if (items.length === 0) items = adaptItems(source, raw);
  if (items.length === 0) return { proposalId: null, itemCount: 0 };

  // Prose (markdown/obsidian) → DEEP extraction: decompose each note into
  // multiple typed entities + relations, merged + deduplicated across notes.
  // Structured rows (csv/bookmark) stay on the SHALLOW path (1 row = 1 entity,
  // which is correct for them). Deep is best-effort: if it yields nothing
  // (IS down, all timeouts), we fall back to shallow so an import never fails.
  // Prose sources go through DEEP extraction (note/transcript → entity graph).
  // JSON-chat imports are flattened to a transcript by the json adapter, so
  // they belong here too — the conversation content yields entities+relations.
  const isProse =
    source === "obsidian" || source === "markdown" || source === "json";
  let operations: CompositeProposalOperation[] | undefined;
  let summary: string | undefined;
  let itemCount = items.length;

  if (isProse) {
    try {
      const { client } = await resolveIntelligenceService({
        userId,
        workspaceId: wsId,
        capability: "default",
      });
      const deep = await deepStructureImportItems(
        items,
        client,
        {
          availableProfiles,
          validSlugs,
          availableWorkspaces,
          resolveExisting: makeGraphResolver(searchService, {
            userId,
            workspaceId: wsId,
          }),
        },
        { logger }
      );
      if (deep.stats.entityCount > 0) {
        operations = deep.operations;
        itemCount = deep.stats.itemsProcessed;
        summary = buildImportSummary(deep.operations, source);
        logger.info(
          { ...deep.stats, userId, source },
          "deep import structured"
        );
      } else {
        logger.warn(
          { userId, source },
          "deep import produced no entities — falling back to shallow"
        );
      }
    } catch (e) {
      logger.warn(
        { e, userId, source },
        "deep import failed — falling back to shallow"
      );
    }
  }

  if (!operations) {
    // Shallow path: best-effort AI typing (1 item → 1 typed entity). Any IS
    // failure leaves items unchanged and the deterministic proposal stands.
    try {
      const { client } = await resolveIntelligenceService({
        userId,
        workspaceId: wsId,
        capability: "default",
      });
      await aiEnrichImportItems(
        items,
        client,
        { availableProfiles },
        { logger }
      );
    } catch (e) {
      logger.warn(
        { e, userId, source },
        "import submitBatch AI enrich failed, using deterministic"
      );
    }
    const proposal = buildImportProposal(items, "references", validSlugs);
    operations = importProposalToComposite(proposal).operations;
    itemCount = proposal.stats.itemCount;
    summary = buildImportSummary(operations, source);
  }

  const targetId = randomUUID();
  const { proposal: created } = await createEventBackedProposal({
    userId,
    workspaceId,
    targetType: "entity",
    targetId,
    proposalType: "import.graph",
    action: "create",
    source: "intelligence",
    summary,
    sessionId: ctx.sessionId ?? null,
    projectId: ctx.projectId ?? null,
    data: buildImportGraphProposalData({
      operations,
      source,
      sourceId: provenance?.sourceId ?? targetId,
      contentRef: provenance?.contentRef,
    }),
  });

  return {
    proposalId: (created as { id?: string })?.id ?? null,
    itemCount,
  };
}
