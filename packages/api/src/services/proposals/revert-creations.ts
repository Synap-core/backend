/**
 * Undo what ONE proposal materialized — the rows its record names, and only
 * those still untouched.
 *
 * Reads the complete record (`stamp-materialized.ts`), hands it to the one undo
 * engine (`safeRevert`, one transaction, retire-not-destroy), then fires the
 * delete/detach/update events for exactly the rows that were retired — after
 * the commit, so no event describes a write that rolled back.
 *
 * Documents a document-create proposal made are NOT handled here: they have no
 * soft delete, and the router still removes them through the governed document
 * door (storage cleanup lives there). Body documents created WITH an entity are
 * not deleted at all — they ride the entity's soft delete.
 */

import {
  db,
  eq,
  inArray,
  entities,
  relations,
  PropertyIndexService,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { ProposalRevertPlan } from "../../routers/proposals/revert.js";
import { recordDomainMutation } from "../../utils/domain-mutation.js";
import { syncRelationToPropertyOnDelete } from "../../utils/property-relation-sync.js";
import { entityFieldApiName } from "../../utils/entity-property-diff.js";
import {
  safeRevert,
  type RevertPass,
  type RevertSkip,
  type RevertTarget,
  type RevertTransaction,
  type SafeRevertResult,
} from "../reversibility/safe-revert.js";
import {
  subtractFromRecord,
  type CompleteMaterializedRecord,
} from "./stamp-materialized.js";
import type {
  EntityDiffField,
  EntityPropertyDiff,
} from "../../utils/entity-property-diff.js";

const logger = createLogger({ module: "revert-creations" });

export type CreationsRevertPlan = Extract<
  ProposalRevertPlan,
  { kind: "delete-creations" }
>;

export interface ProposalCreationsRevert {
  /** What was retired, in record shape. */
  undone: CompleteMaterializedRecord;
  /** What was left alone, and why. */
  skipped: RevertSkip[];
  /** The record minus what was undone — the items still live. */
  remaining: CompleteMaterializedRecord;
}

/** Every row the plan names, as undo targets (document-create ids excluded — see header). */
export function revertTargetsFromPlan(
  plan: CreationsRevertPlan
): RevertTarget[] {
  return [
    ...plan.relationIds.map((id) => ({ kind: "relation" as const, id })),
    ...plan.facetIds.map((id) => ({ kind: "facet" as const, id })),
    ...plan.propertyDiffs.flatMap((diff): RevertTarget[] => [
      ...Object.keys(diff.after).map((key) => ({
        kind: "property" as const,
        entityId: diff.entityId,
        key,
        after: diff.after[key],
        before: diff.before[key],
        absentBefore: diff.absentBefore.includes(key),
      })),
      // Keys an update REMOVED: restored to `before` while still absent.
      ...(diff.absentAfter ?? []).map((key) => ({
        kind: "property" as const,
        entityId: diff.entityId,
        key,
        after: undefined,
        before: diff.before[key],
        absentBefore: false,
        absentAfter: true,
      })),
      ...(Object.keys(diff.fields?.after ?? {}) as EntityDiffField[]).map(
        (field) => ({
          kind: "entity_field" as const,
          entityId: diff.entityId,
          field,
          after: diff.fields?.after[field] ?? null,
          before: diff.fields?.before[field] ?? null,
        })
      ),
      ...(diff.bodyDocumentId
        ? [
            {
              kind: "entity_body" as const,
              entityId: diff.entityId,
              documentId: diff.bodyDocumentId,
            },
          ]
        : []),
    ]),
    ...plan.entityIds.map((id) => ({ kind: "entity" as const, id })),
    ...plan.ruleIds.map((id) => ({ kind: "rule" as const, id })),
    ...plan.automationIds.map((id) => ({ kind: "automation" as const, id })),
    ...plan.skillIds.map((id) => ({ kind: "skill" as const, id })),
    // A connected plan's non-entity rows (absent on every older record).
    ...(plan.linkIds ?? []).map((id) => ({ kind: "link" as const, id })),
    ...(plan.projectIds ?? []).map((id) => ({
      kind: "project" as const,
      id,
      ...(plan.projectSubjectIds?.[id]
        ? { subjectEntityId: plan.projectSubjectIds[id] }
        : {}),
    })),
  ];
}

/** One short, human-readable name for a target — for skip lines in a receipt. */
export function describeRevertTarget(target: RevertTarget): string {
  switch (target.kind) {
    case "property":
      return `"${target.key}" on entity ${target.entityId}`;
    case "entity_body":
      return `body of entity ${target.entityId}`;
    case "entity_field":
      return `${entityFieldApiName(target.field)} of entity ${target.entityId}`;
    default:
      return `${target.kind} ${target.id}`;
  }
}

/** The wire shape of a skipped item on a revert receipt. */
export function revertSkipView(skip: RevertSkip): {
  kind: RevertTarget["kind"];
  id: string;
  key?: string;
  reason: RevertSkip["reason"];
  detail: string;
} {
  const target = skip.target;
  return {
    kind: target.kind,
    id:
      target.kind === "property" ||
      target.kind === "entity_body" ||
      target.kind === "entity_field"
        ? target.entityId
        : target.id,
    ...(target.kind === "property" ? { key: target.key } : {}),
    // The API field name, never the column: the `preview` column is the
    // `description` field on every entity door, so a kept key reads the way
    // the client humanizes every other field (vocabulary `humanizeToken`).
    ...(target.kind === "entity_field"
      ? { key: entityFieldApiName(target.field) }
      : {}),
    reason: skip.reason,
    detail: skip.detail,
  };
}

/** Fold retired targets back into record shape. */
function undoneRecord(reverted: RevertTarget[]): CompleteMaterializedRecord {
  const diffs = new Map<string, EntityPropertyDiff>();
  const diffFor = (entityId: string) => {
    const existing = diffs.get(entityId);
    if (existing) return existing;
    const fresh: EntityPropertyDiff = {
      entityId,
      before: {},
      after: {},
      absentBefore: [],
    };
    diffs.set(entityId, fresh);
    return fresh;
  };
  const record: Required<
    Pick<
      CompleteMaterializedRecord,
      | "entityIds"
      | "relationIds"
      | "facetIds"
      | "skillIds"
      | "automationIds"
      | "ruleIds"
      | "sessionIds"
      | "projectIds"
      | "linkIds"
    >
  > = {
    entityIds: [],
    relationIds: [],
    facetIds: [],
    skillIds: [],
    automationIds: [],
    ruleIds: [],
    sessionIds: [],
    projectIds: [],
    linkIds: [],
  };
  for (const target of reverted) {
    switch (target.kind) {
      case "entity":
        record.entityIds.push(target.id);
        break;
      case "relation":
        record.relationIds.push(target.id);
        break;
      case "facet":
        record.facetIds.push(target.id);
        break;
      case "skill":
        record.skillIds.push(target.id);
        break;
      case "automation":
        record.automationIds.push(target.id);
        break;
      case "rule":
        record.ruleIds.push(target.id);
        break;
      case "property": {
        const diff = diffFor(target.entityId);
        if (target.absentAfter) {
          diff.absentAfter = [...(diff.absentAfter ?? []), target.key];
          diff.before[target.key] = target.before;
          break;
        }
        diff.after[target.key] = target.after;
        if (target.absentBefore) diff.absentBefore.push(target.key);
        else diff.before[target.key] = target.before;
        break;
      }
      case "entity_field": {
        const diff = diffFor(target.entityId);
        diff.fields ??= { before: {}, after: {} };
        diff.fields.before[target.field] = target.before;
        diff.fields.after[target.field] = target.after;
        break;
      }
      case "entity_body":
        diffFor(target.entityId).bodyDocumentId = target.documentId;
        break;
      case "link":
        record.linkIds.push(target.id);
        break;
      case "project":
        record.projectIds.push(target.id);
        break;
      case "playbook":
        break;
    }
  }
  return { ...record, propertyDiffs: [...diffs.values()] };
}

export async function revertProposalCreations(args: {
  proposal: {
    id: string;
    workspaceId: string | null;
    sessionId: string | null;
    data: unknown;
  };
  plan: CreationsRevertPlan;
  userId: string;
  /** The enclosing session revert, when there is one (see `RevertPass`). */
  pass?: RevertPass | null;
  /**
   * Sessions the caller ALREADY retired through the one close door (a failed
   * plan's compensation) — excluded from the project in-use check.
   */
  ownSessionIds?: string[];
  /**
   * Write the proposal's own record in the SAME transaction as the undo. A
   * throw (e.g. a lost compare-and-set) rolls the whole undo back.
   */
  writeInTransaction?: (
    tx: RevertTransaction,
    outcome: ProposalCreationsRevert
  ) => Promise<void>;
  database?: typeof db;
}): Promise<ProposalCreationsRevert> {
  const { proposal, plan, userId } = args;
  const database = args.database ?? db;
  const record = ((proposal.data as { materialized?: unknown } | null)
    ?.materialized ?? {}) as CompleteMaterializedRecord;
  const outcomeOf = (result: SafeRevertResult): ProposalCreationsRevert => {
    const undone = undoneRecord(result.reverted);
    return {
      undone,
      skipped: result.skipped,
      remaining: subtractFromRecord(record, undone),
    };
  };

  // Snapshots the post-commit events need (the rows are gone or retired after).
  const relationRows =
    plan.relationIds.length > 0
      ? await database
          .select({
            id: relations.id,
            sourceEntityId: relations.sourceEntityId,
            targetEntityId: relations.targetEntityId,
            type: relations.type,
            workspaceId: relations.workspaceId,
          })
          .from(relations)
          .where(inArray(relations.id, plan.relationIds))
      : [];
  const entityRowIds = [
    ...plan.entityIds,
    ...plan.propertyDiffs.map((d) => d.entityId),
  ];
  const entityRows =
    entityRowIds.length > 0
      ? await database
          .select({
            id: entities.id,
            type: entities.type,
            profileId: entities.profileId,
            workspaceId: entities.workspaceId,
          })
          .from(entities)
          .where(inArray(entities.id, entityRowIds))
      : [];

  const writeInTransaction = args.writeInTransaction;
  const result = await safeRevert({
    targets: revertTargetsFromPlan(plan),
    mode: "skip_touched",
    // A record written before stamps existed carries no `stampedAt`: edit
    // detection is off for it (the old behaviour), lineage still applies.
    touchedSince: record.stampedAt ? new Date(record.stampedAt) : null,
    sourceProposalId: proposal.id,
    sessionId: proposal.sessionId,
    touchedByPass: args.pass ?? null,
    ...(args.ownSessionIds ? { ownSessionIds: args.ownSessionIds } : {}),
    ...(writeInTransaction
      ? {
          alsoInTransaction: (tx, inner) =>
            writeInTransaction(tx, outcomeOf(inner)),
        }
      : {}),
    database,
  });

  const outcome = outcomeOf(result);
  if (args.pass) {
    // The writes this undo makes to entities it does NOT retire — the
    // relation → property reverse sync (source entity, after the commit) and
    // property / body restores — are the pass's own, never an edit.
    for (const row of relationRows) {
      if (
        (outcome.undone.relationIds ?? []).includes(row.id) &&
        row.sourceEntityId
      ) {
        args.pass.entityIds.add(row.sourceEntityId);
      }
    }
    for (const diff of outcome.undone.propertyDiffs ?? []) {
      args.pass.entityIds.add(diff.entityId);
    }
  }

  emitRevertEvents({
    undone: outcome.undone,
    proposal,
    userId,
    relationRows,
    entityRows,
    database,
  });

  return outcome;
}

/** Best-effort fan-out for the retired rows. Never throws. */
function emitRevertEvents(args: {
  undone: CompleteMaterializedRecord;
  proposal: {
    id: string;
    workspaceId: string | null;
    sessionId: string | null;
  };
  userId: string;
  relationRows: Array<{
    id: string;
    sourceEntityId: string | null;
    targetEntityId: string | null;
    type: string;
    workspaceId: string | null;
  }>;
  entityRows: Array<{
    id: string;
    type: string | null;
    profileId: string | null;
    workspaceId: string | null;
  }>;
  database: typeof db;
}): void {
  const { undone, proposal, userId } = args;
  const base = {
    userId,
    workspaceId: proposal.workspaceId,
    sessionId: proposal.sessionId,
  };
  const reason = { reason: "proposal.revert", proposalId: proposal.id };
  const entityById = new Map(args.entityRows.map((e) => [e.id, e]));

  for (const entityId of undone.entityIds ?? []) {
    void recordDomainMutation({
      ...base,
      subjectType: "entity",
      action: "delete",
      subjectId: entityId,
      data: {
        profileSlug: entityById.get(entityId)?.type ?? undefined,
        ...reason,
      },
      logData: reason,
    });
  }

  for (const row of args.relationRows) {
    if (!(undone.relationIds ?? []).includes(row.id)) continue;
    void recordDomainMutation({
      ...base,
      subjectType: "relation",
      action: "delete",
      subjectId: row.id,
      logData: { id: row.id, ...reason },
      data: {
        relationType: row.type,
        fromEntityId: row.sourceEntityId,
        toEntityId: row.targetEntityId,
        ...reason,
      },
    });
    if (row.sourceEntityId && row.targetEntityId) {
      syncRelationToPropertyOnDelete(
        row.sourceEntityId,
        row.targetEntityId,
        row.type,
        row.workspaceId
      ).catch((err) =>
        logger.warn(
          { err, relationId: row.id },
          "revert: relation→property reverse sync failed (link removed)"
        )
      );
    }
  }

  for (const facetId of undone.facetIds ?? []) {
    void recordDomainMutation({
      ...base,
      subjectType: "entity_facet",
      action: "detach",
      subjectId: facetId,
      data: reason,
    });
  }

  for (const diff of undone.propertyDiffs ?? []) {
    const changedKeys = [
      ...Object.keys(diff.after),
      ...(diff.absentAfter ?? []),
    ];
    void recordDomainMutation({
      ...base,
      subjectType: "entity",
      action: "update",
      subjectId: diff.entityId,
      data: { changedKeys, ...reason },
      logData: reason,
    });
    const row = entityById.get(diff.entityId);
    if (row?.profileId && changedKeys.length > 0) {
      void reindexAfterRestore(
        args.database,
        diff.entityId,
        row.profileId,
        row.workspaceId
      );
    }
  }

  for (const [subjectType, ids] of [
    ["automation", undone.automationIds ?? []],
    ["skill", [...(undone.skillIds ?? []), ...(undone.ruleIds ?? [])]],
  ] as const) {
    for (const id of ids) {
      void recordDomainMutation({
        ...base,
        subjectType,
        action: "update",
        subjectId: id,
        data: {
          status: subjectType === "automation" ? "archived" : "inactive",
          ...reason,
        },
      });
    }
  }
}

async function reindexAfterRestore(
  database: typeof db,
  entityId: string,
  profileId: string,
  workspaceId: string | null
): Promise<void> {
  try {
    const [row] = await database
      .select({ properties: entities.properties })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    await new PropertyIndexService(database).reindexEntity(
      entityId,
      (row?.properties ?? {}) as Record<string, unknown>,
      profileId,
      workspaceId
    );
  } catch (err) {
    logger.warn(
      { err, entityId },
      "revert: property reindex after restore failed (values restored)"
    );
  }
}
