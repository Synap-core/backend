/**
 * THE record of what a materialization produced — built once, written once.
 *
 * `data.materialized` on a proposal is what `revert` reads to compute the
 * inverse. Four doors materialize (approve, capture auto-apply, text-lane
 * `capture.execute`, `import.apply`/`applyLarge`) and each used to hand-write
 * its own record — entity ids only. Relations, facets, config rows and what a
 * merge overwrote on an existing entity were never recorded, so an undo could
 * only ever be partial, and the import door recorded nothing at all.
 *
 * `buildMaterializedRecord` turns a `MaterializeResult` into the complete
 * record; `stampMaterialized` MERGES it into the row. Merging, not replacing:
 * a retried apply links what the first attempt created (idempotency), so its
 * own result lists those entities as linked — replacing would erase the first
 * attempt's record and make the created rows unrevertable.
 *
 * `stampedAt` is the moment the record was written. Revert treats a row
 * written after it as touched by someone else and leaves it alone.
 */

import { db, eq, proposals } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { ProposalMaterializedRecord } from "@synap-core/types";
import { opRef } from "@synap-core/types/proposals";
import { createLogger } from "@synap-core/core";
import type { MaterializeResult } from "../../utils/materialize-composite.js";
import type { EntityPropertyDiff } from "../../utils/entity-property-diff.js";

const logger = createLogger({ module: "stamp-materialized" });

/**
 * The complete created-rows record. Extends the shared
 * `ProposalMaterializedRecord` (`@synap-core/types`) with the fields only the
 * api writes and reads today.
 */
export interface CompleteMaterializedRecord extends ProposalMaterializedRecord {
  /** Facets attached by the run (revert re-checks each row's lineage). */
  facetIds?: string[];
  /** Rule Loop config rows created by the run. */
  skillIds?: string[];
  automationIds?: string[];
  /** Rules are `skills` rows (`kind: "rule"`). */
  ruleIds?: string[];
  /**
   * Body documents created WITH an entity. They ride the entity's soft delete
   * (a restored entity keeps its body), so revert never deletes them on their
   * own — unlike `documentIds`, which a document-create proposal owns.
   */
  entityDocumentIds?: string[];
  /** What merges overwrote on PRE-EXISTING entities, with prior values. */
  propertyDiffs?: EntityPropertyDiff[];
  /** Connected plan: focus sessions, projects and session edges created by the run. */
  sessionIds?: string[];
  projectIds?: string[];
  linkIds?: string[];
  /** projectId → the subject entity the run bound it to (its own edge, see safe-revert). */
  projectSubjectIds?: Record<string, string>;
  /** ISO time the record was last stamped. */
  stampedAt?: string;
  /**
   * The same rows, keyed by the op that produced them — what an undo of ONE
   * item reads. Key: the op's `ref` (a ref-less entity: the canonical
   * `opRef(n)`, n = its ordinal among create_entity ops); a relation
   * op has no ref, so it is keyed by the edge it asked for
   * (`<sourceRef>-><targetRef>:<type>`), which survives chunking and retries.
   */
  byOp?: Record<string, MaterializedOpRecord>;
}

/** What one op produced. `linked`/`preExisting` rows were never this run's. */
export interface MaterializedOpRecord {
  op:
    | "create_entity"
    | "create_relation"
    | "create_skill"
    | "create_automation"
    | "create_rule"
    | "create_session"
    | "create_document"
    | "create_project"
    | "create_link";
  entityId?: string;
  linked?: boolean;
  relationId?: string;
  preExisting?: boolean;
  facetIds?: string[];
  skillId?: string;
  automationId?: string;
  ruleId?: string;
  sessionId?: string;
  projectId?: string;
  documentId?: string;
  linkId?: string;
  /** Set when THIS op was reverted on its own (`proposals.revert` with `opKey`). */
  revertedAt?: string;
  revertedBy?: string;
}

/** Mark ops reverted — a second revert of the same op is then a no-op. */
export function markOpsReverted(
  record: CompleteMaterializedRecord,
  keys: string[],
  by: string,
  at: string
): CompleteMaterializedRecord {
  if (!record.byOp) return record;
  const byOp = { ...record.byOp };
  for (const key of keys) {
    if (byOp[key]) byOp[key] = { ...byOp[key], revertedAt: at, revertedBy: by };
  }
  return { ...record, byOp };
}

/** The `byOp` key of a relation op. */
export function relationOpKey(op: {
  sourceRef: string;
  targetRef: string;
  type: string;
}): string {
  return `${op.sourceRef}->${op.targetRef}:${op.type}`;
}

type RecordSource = Pick<MaterializeResult, "entities" | "relations"> &
  Partial<
    Pick<
      MaterializeResult,
      | "facets"
      | "skills"
      | "automations"
      | "rules"
      | "projects"
      | "sessions"
      | "links"
      | "documents"
    >
  >;

/** The `byOp` key of a plan session edge (a link op has no ref). */
export function linkOpKey(link: {
  requested: { from: string; to: string };
  type: string;
}): string {
  return `${link.requested.from}->${link.requested.to}:${link.type}`;
}

function unique(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}

/**
 * Build the complete record from a materializer result. `extra` carries writes
 * a door made OUTSIDE the materializer (the text lane attaches facets and
 * enriches identity matches itself).
 */
export function buildMaterializedRecord(
  result: RecordSource,
  extra?: { facetIds?: string[]; propertyDiffs?: EntityPropertyDiff[] }
): CompleteMaterializedRecord {
  // A retry's link to a row THIS proposal created (lineage-checked by the
  // materializer) is the run's own creation — a crash before the stamp.
  const created = result.entities.filter((e) => !e.linked || e.linkedByRetry);
  const record: CompleteMaterializedRecord = {
    entityIds: unique(created.map((e) => e.entityId)),
    relationIds: unique(
      result.relations
        .filter((r) => !r.preExisting && r.relationId)
        .map((r) => r.relationId as string)
    ),
    entityDocumentIds: unique(
      created.flatMap((e) => (e.documentId ? [e.documentId] : []))
    ),
    facetIds: unique([
      ...(result.facets ?? []).map((f) => f.facetId),
      ...(extra?.facetIds ?? []),
    ]),
    skillIds: unique((result.skills ?? []).map((s) => s.skillId)),
    automationIds: unique(
      (result.automations ?? []).map((a) => a.automationId)
    ),
    ruleIds: unique((result.rules ?? []).map((r) => r.ruleId)),
    propertyDiffs: [
      ...result.entities.flatMap((e) =>
        e.linked && e.propertyDiff ? [e.propertyDiff] : []
      ),
      ...(extra?.propertyDiffs ?? []),
    ],
    ...planRecordFields(result),
    byOp: buildByOp(result),
  };
  return record;
}

/**
 * A connected plan's rows. Present ONLY when the run carried plan results, so
 * an entity/relation graph's record keeps exactly the shape it always had.
 */
function planRecordFields(
  result: RecordSource
): Partial<CompleteMaterializedRecord> {
  const sessions = result.sessions ?? [];
  const projects = result.projects ?? [];
  const links = result.links ?? [];
  const documents = result.documents ?? [];
  if (
    sessions.length + projects.length + links.length + documents.length ===
    0
  ) {
    return {};
  }
  // A project the door REUSED (exact-name match) is not this run's row.
  const ownProjects = projects.filter((p) => !p.linked);
  return {
    sessionIds: unique(sessions.map((s) => s.sessionId)),
    projectIds: unique(ownProjects.map((p) => p.projectId)),
    linkIds: unique(
      links
        .filter((l) => !l.preExisting && l.linkId)
        .map((l) => l.linkId as string)
    ),
    projectSubjectIds: Object.fromEntries(
      ownProjects.flatMap((p) =>
        p.subjectEntityId ? [[p.projectId, p.subjectEntityId]] : []
      )
    ),
    // Plan documents are standalone rows (not entity bodies): revert deletes
    // them through the governed document door, exactly like a document-create
    // proposal's own `documentIds`.
    documentIds: unique(documents.map((d) => d.documentId)),
  };
}

function buildByOp(result: RecordSource): Record<string, MaterializedOpRecord> {
  const byOp: Record<string, MaterializedOpRecord> = {};
  // A ref-less entity is keyed by the CANONICAL positional ref — `opRef(n)` is
  // the Nth create_entity op, the id space dispositions and the scanner use —
  // never by its index among ALL ops (a rule op before it would shift it).
  //
  // LIMIT, stated: the ordinal counts entity RESULTS. A create_entity op the
  // materializer skips (the relation-slug guard) has no result, so a ref-less
  // entity after it is keyed one lower than the canonical ref.
  const entityKeyByIndex = new Map<number, string>();
  let entityOrdinal = 0;
  for (const e of [...result.entities].sort((a, b) => a.opIndex - b.opIndex)) {
    const key = e.ref ?? opRef(entityOrdinal);
    entityOrdinal++;
    entityKeyByIndex.set(e.opIndex, key);
    byOp[key] = {
      op: "create_entity",
      entityId: e.entityId,
      linked: e.linked && !e.linkedByRetry,
    };
  }
  for (const f of result.facets ?? []) {
    const key = f.ref ?? entityKeyByIndex.get(f.opIndex);
    const entry = key ? byOp[key] : undefined;
    if (entry) entry.facetIds = unique([...(entry.facetIds ?? []), f.facetId]);
  }
  for (const r of result.relations) {
    if (!r.requested) continue;
    byOp[relationOpKey(r.requested)] = {
      op: "create_relation",
      ...(r.relationId ? { relationId: r.relationId } : {}),
      ...(r.preExisting ? { preExisting: true } : {}),
    };
  }
  for (const s of result.skills ?? []) {
    byOp[s.ref] = { op: "create_skill", skillId: s.skillId };
  }
  for (const a of result.automations ?? []) {
    byOp[a.ref] = { op: "create_automation", automationId: a.automationId };
  }
  for (const r of result.rules ?? []) {
    byOp[r.ref] = { op: "create_rule", ruleId: r.ruleId };
  }
  for (const p of result.projects ?? []) {
    byOp[p.ref] = {
      op: "create_project",
      projectId: p.projectId,
      linked: p.linked,
    };
  }
  for (const s of result.sessions ?? []) {
    byOp[s.ref] = { op: "create_session", sessionId: s.sessionId };
  }
  for (const d of result.documents ?? []) {
    byOp[d.ref] = { op: "create_document", documentId: d.documentId };
  }
  // An edge has no ref of its own — keyed by what it asked for, like a relation.
  for (const l of result.links ?? []) {
    byOp[linkOpKey(l)] = {
      op: "create_link",
      ...(l.linkId ? { linkId: l.linkId } : {}),
      ...(l.preExisting ? { preExisting: true } : {}),
    };
  }
  return byOp;
}

/**
 * A retry links what the first attempt created, so its entry says `linked`.
 * The first attempt's "created" stands — otherwise the row reads as never ours.
 */
function mergeOpRecord(
  older: MaterializedOpRecord | undefined,
  newer: MaterializedOpRecord
): MaterializedOpRecord {
  if (!older) return newer;
  // The op was reverted and has run again (re-approve after reopen): the old
  // entry names rows that are gone — the new run's entry is the record.
  if (older.revertedAt) return newer;
  // A relation the first attempt created keeps its id and ownership.
  if (older.relationId) return older;
  const facetIds = unique([
    ...(older.facetIds ?? []),
    ...(newer.facetIds ?? []),
  ]);
  return {
    ...older,
    ...newer,
    ...(older.linked === false ? { linked: false } : {}),
    ...(facetIds.length > 0 ? { facetIds } : {}),
  };
}

/** Fold two diffs of the SAME entity: the OLDER prior value wins, the newer written value wins. */
function mergeDiff(
  older: EntityPropertyDiff,
  newer: EntityPropertyDiff
): EntityPropertyDiff {
  const before = { ...older.before };
  const after = { ...older.after };
  const absentBefore = new Set(older.absentBefore);
  for (const [key, value] of Object.entries(newer.after)) {
    if (!(key in older.after)) {
      if (newer.absentBefore.includes(key)) absentBefore.add(key);
      else before[key] = newer.before[key];
    }
    after[key] = value;
  }
  const bodyDocumentId = older.bodyDocumentId ?? newer.bodyDocumentId;
  return {
    entityId: older.entityId,
    before,
    after,
    absentBefore: [...absentBefore],
    ...(bodyDocumentId ? { bodyDocumentId } : {}),
  };
}

const ID_FIELDS = [
  "entityIds",
  "relationIds",
  "documentIds",
  "facetIds",
  "skillIds",
  "automationIds",
  "ruleIds",
  "entityDocumentIds",
  "sessionIds",
  "projectIds",
  "linkIds",
] as const satisfies ReadonlyArray<keyof CompleteMaterializedRecord>;

/** Union two records. Keeps any fields a record carries that this module does not own (e.g. `merge`). */
export function mergeMaterializedRecords(
  older: CompleteMaterializedRecord | null | undefined,
  newer: CompleteMaterializedRecord
): CompleteMaterializedRecord {
  const merged: CompleteMaterializedRecord = { ...(older ?? {}), ...newer };
  for (const field of ID_FIELDS) {
    const ids = unique([...(older?.[field] ?? []), ...(newer[field] ?? [])]);
    if (ids.length > 0 || older?.[field] || newer[field]) merged[field] = ids;
  }
  const diffs = new Map<string, EntityPropertyDiff>();
  for (const diff of [
    ...(older?.propertyDiffs ?? []),
    ...(newer.propertyDiffs ?? []),
  ]) {
    const prior = diffs.get(diff.entityId);
    diffs.set(diff.entityId, prior ? mergeDiff(prior, diff) : diff);
  }
  merged.propertyDiffs = [...diffs.values()];
  if (older?.byOp || newer.byOp) {
    const byOp = { ...(older?.byOp ?? {}) };
    for (const [key, entry] of Object.entries(newer.byOp ?? {})) {
      byOp[key] = mergeOpRecord(byOp[key], entry);
    }
    merged.byOp = byOp;
  }
  merged.stampedAt = newer.stampedAt ?? older?.stampedAt;
  return merged;
}

/**
 * Remove what a revert undid from a record, so the record keeps naming only
 * what is still live (the items revert skipped). A later re-approval then
 * merges onto the leftovers, not onto rows that are already gone.
 */
export function subtractFromRecord(
  record: CompleteMaterializedRecord,
  undone: CompleteMaterializedRecord
): CompleteMaterializedRecord {
  const remaining: CompleteMaterializedRecord = { ...record };
  for (const field of ID_FIELDS) {
    if (!record[field]) continue;
    const drop = new Set(undone[field] ?? []);
    remaining[field] = record[field]!.filter((id) => !drop.has(id));
  }
  const undoneDiffs = new Map(
    (undone.propertyDiffs ?? []).map((d) => [d.entityId, d])
  );
  remaining.propertyDiffs = (record.propertyDiffs ?? []).flatMap((diff) => {
    const gone = undoneDiffs.get(diff.entityId);
    if (!gone) return [diff];
    const keys = Object.keys(diff.after).filter((k) => !(k in gone.after));
    const bodyDocumentId =
      diff.bodyDocumentId && diff.bodyDocumentId !== gone.bodyDocumentId
        ? diff.bodyDocumentId
        : undefined;
    if (keys.length === 0 && !bodyDocumentId) return [];
    return [
      {
        entityId: diff.entityId,
        before: Object.fromEntries(
          keys.filter((k) => k in diff.before).map((k) => [k, diff.before[k]])
        ),
        after: Object.fromEntries(keys.map((k) => [k, diff.after[k]])),
        absentBefore: diff.absentBefore.filter((k) => keys.includes(k)),
        ...(bodyDocumentId ? { bodyDocumentId } : {}),
      },
    ];
  });
  return remaining;
}

type StampDatabase = Pick<typeof db, "query" | "update">;

type ProposalColumns = typeof proposals.$inferInsert;

/**
 * Merge `record` into `proposals.data.materialized` and write it — the ONE
 * writer every materializer uses. `set` rides the same UPDATE so a door that
 * flips status at the same moment (approve) stays a single statement.
 *
 * `baseData` is the row's data as the caller already holds it (approve loaded
 * the proposal; the capture receipt insert returned its row) — the write merges
 * over it so fields other writers folded in (correlationId, requestedEventId,
 * idempotencyKey) survive. Without it the row is read first (the import door
 * holds only an id).
 */
export async function stampMaterialized(args: {
  proposalId: string;
  record: CompleteMaterializedRecord;
  database?: StampDatabase;
  baseData?: Record<string, unknown> | null;
  dataPatch?: Record<string, unknown>;
  set?: Omit<Partial<ProposalColumns>, "data" | "id">;
}): Promise<CompleteMaterializedRecord> {
  const database = args.database ?? db;
  const currentData = (args.baseData ??
    ((
      await database.query.proposals.findFirst({
        where: eq(proposals.id, args.proposalId),
        columns: { data: true },
      })
    )?.data as Record<string, unknown> | undefined) ??
    {}) as Record<string, unknown>;
  const merged = mergeMaterializedRecords(
    currentData.materialized as CompleteMaterializedRecord | undefined,
    { ...args.record, stampedAt: new Date().toISOString() }
  );
  await database
    .update(proposals)
    .set({
      ...(args.set ?? {}),
      data: { ...currentData, ...(args.dataPatch ?? {}), materialized: merged },
    })
    .where(eq(proposals.id, args.proposalId));
  return merged;
}

/**
 * Run a materialization under a receipt that was inserted BEFORE it (the
 * receipt id is a foreign key the created rows carry). If materialization
 * throws, the receipt is marked `approval_failed` so it never reads as a
 * success that created nothing. The throw is re-raised.
 *
 * The ONE copy: `capture.execute` and `submit-capture-graph.ts` both import it
 * (the latter's private duplicate was removed 2026-09-13). Why a receipt is
 * marked and never deleted: a partially-materialized graph may already have
 * rows pointing at it, and the FK is ON DELETE SET NULL — deleting it would
 * erase the provenance the linkage exists for.
 */
export async function runMaterializationUnderReceipt<T>(
  receipt: { id?: string; data?: Record<string, unknown> } | undefined,
  run: () => Promise<T>,
  database: Pick<typeof db, "update"> = db
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (receipt?.id) {
      try {
        await database
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVAL_FAILED,
            data: {
              ...(receipt.data ?? {}),
              materializationError:
                err instanceof Error ? err.message : String(err),
            },
          })
          .where(eq(proposals.id, receipt.id));
      } catch (markErr) {
        logger.error(
          { err: markErr, proposalId: receipt.id },
          "materialization failed and the receipt could not be marked approval_failed — row may overstate what landed"
        );
      }
    }
    throw err;
  }
}
