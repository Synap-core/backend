import {
  db,
  getDb,
  ProfileResolutionService,
  PropertyValidationService,
  KnowledgeFormConflictError,
  resolveKindWritePin,
  eq,
  workspaces,
  workspaceMembers,
  entities,
  and,
  inArray,
  isNull,
  drizzleSql,
} from "@synap/database";
import {
  workspaceLensWhere,
  ownerPrivateVisibleWhere,
} from "../../utils/user-visible-where.js";
import {
  normalizeLinkTargetName,
  toSlug,
  type ImportItem,
} from "../../import/import-items.js";
import { createLogger } from "@synap-core/core";
import {
  buildAvailableProfiles,
  withEffectiveProperties,
  type AccessibleProfileLike,
} from "../../routers/capture.js";
import { completeKnowledgeProperties } from "@synap/database";
import {
  parseCsvTable,
  type CsvTablePlan,
} from "../../import/import-adapters.js";
import type { CsvProfileCatalogEntry } from "../../import/csv-table-refine.js";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  computeImportGraphIdempotencyKey,
  findPriorCaptureGraphProposal,
} from "../../utils/pending-capture-dedup.js";
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
 * proposal-creation sites (analyze / analyzeLarge) cannot drift —
 * a new provenance field is added ONCE, here. These keys are read by
 * `buildRequestFromProposal` → the proposal review UI:
 *   source     — where it came from
 *   sourceId   — stable id of this import unit (batchId, else the proposal target)
 *   contentRef — object-storage location of the raw uploaded blob, when one exists
 *   reasoning  — human-readable justification, when a producer has one
 *   idempotencyKey — content hash of the graph, so a re-analyze of the SAME
 *                    corpus resolves to the prior proposal instead of filing a
 *                    duplicate. Derived HERE (not at the call sites) so no
 *                    import writer can forget it — the exact defect this closes:
 *                    3 of 4 `import.graph` writers stamped nothing, and
 *                    `data->>'idempotencyKey' = $key` never matches NULL, so a
 *                    keyless proposal was invisible to dedup forever.
 *                    Omitted (not null) when the graph is degenerate — see
 *                    `computeImportGraphIdempotencyKey`.
 */
export function buildImportGraphProposalData(input: {
  operations: CompositeProposalOperation[];
  source: string;
  sourceId: string;
  /** Scope folded into the idempotency key (parity with the capture lane). */
  workspaceId?: string | null;
  projectId?: string | null;
  /** See `importGraphIdempotencyKey` — a rerun session's own dedup namespace. */
  idempotencyNamespace?: string;
  contentRef?: { storageKey: string; mimeType?: string; size?: number };
  reasoning?: string;
  /** Continuous-improvement report (refuse → inspect → re-run → apply). */
  quality?: unknown;
  homes?: unknown;
  corpusMap?: unknown;
  /** Staged raw item documents (`recordImportIntake`). Empty ⇒ omitted. */
  sourceDocumentIds?: string[];
}): Record<string, unknown> {
  const idempotencyKey = importGraphIdempotencyKey(input);
  return {
    operations: input.operations,
    source: input.source,
    sourceId: input.sourceId,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(input.sourceDocumentIds?.length
      ? { sourceDocumentIds: input.sourceDocumentIds }
      : {}),
    ...(input.contentRef ? { contentRef: input.contentRef } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(input.homes ? { homes: input.homes } : {}),
    ...(input.corpusMap ? { corpusMap: input.corpusMap } : {}),
  };
}

/**
 * The dedup LOOKUP for the import lane — the sibling of the stamp above, and the
 * half without which stamping is inert (the lane never called it: only
 * `submitCaptureGraph` did). Mirrors `submitCaptureGraph`'s handling exactly:
 * the caller's OWN prior pending / auto-approved `import.graph` proposal under
 * the SAME content key is RETURNED instead of filing a second row.
 *
 * Best-effort by design: a lookup hiccup must never block a real import, so any
 * throw falls through to `null` (= file normally), same as the capture lane.
 * A `null` key (degenerate graph) short-circuits — it must never be turned into
 * a `data->>'idempotencyKey' IS NULL` scan, which would make every keyless
 * historical proposal match everything.
 */
/**
 * THE import-graph dedup key — used by BOTH the stamp and the lookup above, so
 * the two can never disagree. Without a namespace it is exactly the content
 * key (every existing caller is unchanged). With one — a rerun session's
 * `rerun:<sessionId>` — the content key is prefixed, so re-structuring the SAME
 * corpus in a new session files its own proposal instead of handing back the
 * parent's, while a double submit inside that session still dedups. A
 * degenerate graph stays keyless either way.
 */
export function importGraphIdempotencyKey(input: {
  workspaceId?: string | null;
  projectId?: string | null;
  operations: ReadonlyArray<CompositeProposalOperation>;
  idempotencyNamespace?: string;
}): string | null {
  const contentKey = computeImportGraphIdempotencyKey({
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    operations: input.operations,
  });
  if (!contentKey) return null;
  return input.idempotencyNamespace
    ? `${input.idempotencyNamespace}:${contentKey}`
    : contentKey;
}

export async function findPriorImportGraphProposal(
  input: {
    userId: string;
    workspaceId: string | null;
    projectId?: string | null;
    operations: CompositeProposalOperation[];
    idempotencyNamespace?: string;
  },
  /** Test seam only — production always uses the module-level connection. */
  database: typeof db = db
): Promise<{ id: string; status: string; sessionId: string | null } | null> {
  const idempotencyKey = importGraphIdempotencyKey(input);
  if (!idempotencyKey) return null;
  try {
    const prior = await findPriorCaptureGraphProposal(database, {
      userId: input.userId,
      idempotencyKey,
    });
    // `sessionId` so a re-sent analyze lands in the PRIOR run's room — the
    // caller owner-checks it before reuse.
    return prior
      ? {
          id: prior.id,
          status: prior.status,
          sessionId: prior.sessionId ?? null,
        }
      : null;
  } catch (err) {
    logger.warn(
      { err, userId: input.userId },
      "import.graph: prior-proposal idempotency lookup failed (filing fresh)"
    );
    return null;
  }
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
  /**
   * Every accessible profile with its kind/role nature, the kinds a role may
   * sit on, and its effective property slugs — what the deterministic CSV
   * post-plan step (`refineCsvTablePlan`) reads to map a planner's columns onto
   * EXISTING properties and turn a role pick into kind + facet.
   */
  profileCatalog: CsvProfileCatalogEntry[];
};

/** Project the accessible profiles (+ their effective properties) into the
 *  catalog `refineCsvTablePlan` reads. Pure. */
export function buildCsvProfileCatalog(
  profiles: ReadonlyArray<
    AccessibleProfileLike & {
      profileKind?: string | null;
      applicableKinds?: string[] | null;
    }
  >
): CsvProfileCatalogEntry[] {
  return profiles.map((p) => ({
    slug: p.slug,
    profileKind: p.profileKind === "role" ? "role" : "kind",
    applicableKinds: Array.isArray(p.applicableKinds) ? p.applicableKinds : [],
    propertySlugs: (p.effectiveProperties ?? []).map((prop) => prop.slug),
  }));
}

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
        // Use the canonical compatibility door — it carries the same inference
        // logic as the capture free-text lane, via inferKnowledgeForm from the
        // entity's own words. Previously the structured `entities[]` lane called the
        // bare `normalizeKnowledgeProperties` which silently dropped the required
        // `knowledgeForm` when there is no legacy `ek_type`. The wrapper carries the
        // fallback, and `completeKnowledgeProperties` is the existing write-time door
        // designed for exactly this case.
        //
        // Infer from BODY, not title. A title is a much weaker discriminator than
        // body text — "pod setup" contains no caution keywords and would default to
        // "fact" silently, which is a quiet wrong answer. The free-text lane uses
        // input.content.slice(0, 200); match it. Fall back to title only when the
        // entity has no body (a structured entity that is title-only is genuinely
        // ambiguous, and title is the best evidence we have).
        // The required claim comes from the TITLE first (a knowledge title is
        // the claim's short handle), never from the 200-char inference slice.
        propsToCheck = completeKnowledgeProperties(
          propsToCheck,
          (content ?? title ?? "").slice(0, 200),
          [title, content]
        );
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
  const withProps = await withEffectiveProperties(
    profileService,
    accessible as unknown as AccessibleProfileLike[],
    workspaceId
  );
  const availableProfiles = buildAvailableProfiles(withProps);
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
    // `withEffectiveProperties` spreads the bare profile rows, so `profileKind`
    // and `applicableKinds` ride along untyped.
    profileCatalog: buildCsvProfileCatalog(withProps),
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
/**
 * What the planner is asked. The role sentence matters: a contacts table is
 * people wearing the `contact` role, and the pod turns a role pick into its
 * kind + the role facet (`refineCsvTablePlan`) — never a role-typed entity.
 */
export const CSV_TABLE_INTENT =
  "Import this CSV table as typed entities (one row = one entity). " +
  "When every row is a person or an organisation playing a role listed in the " +
  "profiles (for example contact, client, lead), pick that role's slug: it is " +
  "stored as the matching kind with the role attached.";

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
      intent: CSV_TABLE_INTENT,
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

/** Titles per lookup query (bounded IN list). */
const LINK_TARGET_LOOKUP_CHUNK = 500;

/**
 * Point each link-target item (an employer a CSV row names — see
 * `addLinkTargetItems`) at the pod entity that already IS it: same kind, same
 * title (case- and whitespace-insensitive), visible to the caller under the
 * same scope `makeGraphResolver` uses. Sets `existingEntityId` in place and
 * returns how many were linked.
 *
 * Why at analyze: an exact same-kind title is precisely what `entities.create`'s
 * weak same-name gate refuses at apply, so an import naming an employer the pod
 * already holds would otherwise fail on approval instead of linking. One query
 * per kind per chunk — a 1,500-row file naming 800 employers is two queries,
 * not 800. A failed lookup THROWS: it is not "nothing exists".
 */
export async function linkExistingImportTargets(
  ctx: Pick<OrchestratorContext, "userId" | "workspaceId">,
  targets: ImportItem[],
  database: typeof db = db
): Promise<number> {
  const { userId, workspaceId } = ctx;
  const scope = workspaceId
    ? workspaceLensWhere(entities.workspaceId, userId, workspaceId, {
        includeGlobals: true,
      })
    : ownerPrivateVisibleWhere(entities.workspaceId, entities.userId, userId);

  const byKind = new Map<string, ImportItem[]>();
  for (const item of targets) {
    if (!item.typeHint || item.existingEntityId) continue;
    const kind = toSlug(item.typeHint);
    const list = byKind.get(kind) ?? [];
    list.push(item);
    byKind.set(kind, list);
  }

  let linked = 0;
  for (const [kind, items] of byKind) {
    const names = [
      ...new Set(items.map((it) => normalizeLinkTargetName(it.title))),
    ];
    const found = new Map<string, string>();
    for (let i = 0; i < names.length; i += LINK_TARGET_LOOKUP_CHUNK) {
      const chunk = names.slice(i, i + LINK_TARGET_LOOKUP_CHUNK);
      // Same normalisation as `normalizeLinkTargetName`: whitespace runs → one
      // space, trimmed, lower-cased.
      const normalizedTitle = drizzleSql<string>`lower(btrim(regexp_replace(${entities.title}, '[[:space:]]+', ' ', 'g')))`;
      const rows = await database
        .select({ id: entities.id, key: normalizedTitle })
        .from(entities)
        .where(
          and(
            eq(entities.type, kind),
            isNull(entities.deletedAt),
            inArray(normalizedTitle, chunk),
            scope
          )
        )
        // Earliest-created wins, as in `resolveIdentity`'s weak path.
        .orderBy(entities.createdAt);
      for (const row of rows) {
        if (row.key && !found.has(row.key)) found.set(row.key, row.id);
      }
    }
    for (const item of items) {
      const id = found.get(normalizeLinkTargetName(item.title));
      if (id) {
        item.existingEntityId = id;
        linked++;
      }
    }
  }
  return linked;
}
