/**
 * SAFE REVERT — the ONE undo engine.
 *
 * Every inverse verb that retires rows a piece of work created goes through
 * here: a proposal revert (the rows an approval or import materialized), a
 * session revert (all of a session's proposals), and a session → playbook /
 * project conversion undo. Three rules, all lifted from the conversion undo
 * (`session-conversion.ts`), where they were first written:
 *
 *  1. UNTOUCHED ONLY. A row somebody used or edited after the work that
 *     created it is not the work's to take back. Such an item is SKIPPED with
 *     a reason the caller can show — never silently deleted, never silently
 *     kept. "Touched" is decided per kind (an automation that has run, an
 *     entity updated or linked to after the record was stamped, a playbook that
 *     has run, a project something else points at).
 *  2. ONE TRANSACTION — checks included. Every target row is read `FOR UPDATE`
 *     inside the same transaction that retires it, so an edit cannot land
 *     between "this is untouched" and the write. A half-applied undo is worse
 *     than one that fails and can be retried.
 *  3. RETIRE, DON'T DESTROY. Entities and facets are soft-deleted, automations
 *     / playbooks / projects archived, skills and rules made inactive — a
 *     restore stays possible. Relations have no soft-delete column and are
 *     deleted, exactly as the relation delete door does.
 *
 * WHAT THE LOCK DOES NOT COVER, stated: the target ROWS are locked; the "linked
 * to something since" / "given a new role since" / "has run" checks are counts
 * read in the same transaction but lock no range, so a link or run inserted by
 * another transaction after the count is not blocked.
 *
 * Two modes: `all_or_nothing` (the conversion undo — one touched object and
 * nothing happens) and `skip_touched` (a run revert — revert what is untouched,
 * report the rest).
 *
 * Events are the caller's job, AFTER this returns — an event for a write that
 * rolled back would be a lie.
 */

import {
  db,
  and,
  eq,
  ne,
  not,
  or,
  gt,
  inArray,
  isNull,
  count,
  entities,
  relations,
  entityFacets,
  automations,
  automationRuns,
  skills,
  focusSessions,
  playbooks,
  playbookRuns,
  projects,
  links,
} from "@synap/database";

export type RevertTarget =
  | { kind: "entity"; id: string }
  | { kind: "relation"; id: string }
  | { kind: "facet"; id: string }
  | { kind: "automation"; id: string }
  | { kind: "skill"; id: string }
  /** A rule is a `skills` row; kept distinct so outcomes name it as a rule. */
  | { kind: "rule"; id: string }
  | { kind: "playbook"; id: string }
  | {
      kind: "project";
      id: string;
      /**
       * The subject the SAME work bound to it — its `project --targets-->
       * entity` edge is the project's own, not a use by something else.
       */
      subjectEntityId?: string;
    }
  /** A `links` row (a plan's `blocked_by` / `spawned_from` edge). Deleted, like a relation. */
  | { kind: "link"; id: string }
  /** One property a merge overwrote on a pre-existing entity. */
  | {
      kind: "property";
      entityId: string;
      key: string;
      /** The value the run wrote — restore only while the key still holds it. */
      after: unknown;
      /** Prior value (ignored when `absentBefore`). */
      before: unknown;
      absentBefore: boolean;
    }
  /** A body document a merge linked onto an entity that had none. */
  | { kind: "entity_body"; entityId: string; documentId: string };

export type RevertSkipReason =
  /** Changed after the work that created it. */
  | "edited_since"
  /** Something else uses it now (a run, a link, another session). */
  | "in_use"
  /** Already retired — nothing left to undo. */
  | "already_reverted"
  | "not_found"
  /** Its lineage names different work — it was never this work's row. */
  | "not_owned";

export interface RevertSkip {
  target: RevertTarget;
  reason: RevertSkipReason;
  detail: string;
}

export interface SafeRevertResult {
  reverted: RevertTarget[];
  skipped: RevertSkip[];
}

type Database = typeof db;
export type RevertTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
type Reader = Database | RevertTransaction;

/**
 * One multi-proposal revert pass (a session revert). Undoing an earlier item
 * can itself bump `updated_at` on an entity a later item still has to judge —
 * the relation → property reverse sync rewrites the link's source entity after
 * the commit. Such a bump is the pass's OWN write, not somebody's edit: an
 * entity named here whose `updated_at` moved no earlier than `startedAt` is not
 * read as `edited_since`. A human edit to the same entity during the pass is
 * indistinguishable and is tolerated too — the window is the pass itself.
 */
export interface RevertPass {
  startedAt: Date;
  entityIds: Set<string>;
}

export interface SafeRevertOptions {
  targets: RevertTarget[];
  mode: "all_or_nothing" | "skip_touched";
  /**
   * When the work's record was written. A row changed after this was touched
   * by someone else. Null ⇒ no edit detection (a legacy record with no stamp).
   */
  touchedSince?: Date | null;
  /**
   * The proposal the rows must name as `source_proposal_id`. A row naming a
   * DIFFERENT proposal is refused as `not_owned`; a row with none (written
   * before lineage existed) is accepted on the record's word.
   */
  sourceProposalId?: string | null;
  /** The session the work ran in — its `produced` edges to retired entities go too. */
  sessionId?: string | null;
  /**
   * Sessions the same work created and ALREADY retired through the one close
   * door. A session's terminal status is never stamped here (that door owns
   * it, `session-terminal-one-door` tripwire); these are only excluded from
   * the "something else uses the project" check.
   */
  ownSessionIds?: string[];
  /** The session's subject entity — the edge a project spawn wrote to it is its own. */
  subjectEntityId?: string | null;
  /** The enclosing multi-proposal pass, when there is one (see `RevertPass`). */
  touchedByPass?: RevertPass | null;
  /**
   * Extra writes that must land in the SAME transaction, given what this undo
   * retired. A throw rolls the whole undo back.
   */
  alsoInTransaction?: (
    tx: RevertTransaction,
    result: SafeRevertResult
  ) => Promise<void>;
  database?: Database;
}

/**
 * Timestamps come from two clocks (Postgres `now()` in microseconds, JS `Date`
 * in milliseconds) and the record is stamped at the end of the same request
 * that created the rows. A row is only "changed since" when it moved more than
 * this after the stamp.
 */
export const TOUCH_TOLERANCE_MS = 1000;

interface InspectContext {
  since: Date | null;
  sourceProposalId: string | null;
  relationIds: string[];
  facetIds: string[];
  /**
   * Sessions the SAME work created and has already retired through the one
   * close door (`completeFocusSession`) — not a "use" of a project it retires.
   */
  sessionIds: string[];
  /** Links retired by THIS undo — never a "use" of a project it also retires. */
  linkIds: string[];
  sessionId: string | null;
  subjectEntityId: string | null;
  pass: RevertPass | null;
}

function changedAfter(ts: Date | null | undefined, since: Date | null) {
  return !!since && !!ts && ts.getTime() > since.getTime() + TOUCH_TOLERANCE_MS;
}

/** The bump came from this pass's own earlier write (see `RevertPass`). */
function bumpedByPass(
  entityId: string,
  ts: Date | null | undefined,
  ctx: InspectContext
): boolean {
  return (
    !!ctx.pass &&
    !!ts &&
    ctx.pass.entityIds.has(entityId) &&
    ts.getTime() >= ctx.pass.startedAt.getTime() - TOUCH_TOLERANCE_MS
  );
}

function foreignLineage(
  rowLineage: string | null | undefined,
  ctx: InspectContext
): boolean {
  return (
    !!ctx.sourceProposalId &&
    !!rowLineage &&
    rowLineage !== ctx.sourceProposalId
  );
}

function skip(
  target: RevertTarget,
  reason: RevertSkipReason,
  detail: string
): RevertSkip {
  return { target, reason, detail };
}

async function inspectEntity(
  reader: Reader,
  target: Extract<RevertTarget, { kind: "entity" }>,
  ctx: InspectContext
): Promise<RevertSkip | null> {
  const [row] = await reader
    .select({
      deletedAt: entities.deletedAt,
      updatedAt: entities.updatedAt,
      sourceProposalId: entities.sourceProposalId,
    })
    .from(entities)
    .where(eq(entities.id, target.id))
    .for("update");
  if (!row) return skip(target, "not_found", "the entity no longer exists");
  if (row.deletedAt) {
    return skip(target, "already_reverted", "the entity is already deleted");
  }
  if (foreignLineage(row.sourceProposalId, ctx)) {
    return skip(target, "not_owned", "the entity was created by other work");
  }
  if (
    changedAfter(row.updatedAt, ctx.since) &&
    !bumpedByPass(target.id, row.updatedAt, ctx)
  ) {
    return skip(
      target,
      "edited_since",
      "the entity was edited after it was created"
    );
  }
  if (ctx.since) {
    const relationConditions = [
      or(
        eq(relations.sourceEntityId, target.id),
        eq(relations.targetEntityId, target.id)
      ),
      gt(
        relations.createdAt,
        new Date(ctx.since.getTime() + TOUCH_TOLERANCE_MS)
      ),
    ];
    if (ctx.relationIds.length > 0) {
      relationConditions.push(not(inArray(relations.id, ctx.relationIds)));
    }
    const [linked] = await reader
      .select({ n: count() })
      .from(relations)
      .where(and(...relationConditions));
    if ((linked?.n ?? 0) > 0) {
      return skip(
        target,
        "in_use",
        "the entity was linked to something else since"
      );
    }
    const facetConditions = [
      eq(entityFacets.entityId, target.id),
      isNull(entityFacets.deletedAt),
      gt(
        entityFacets.createdAt,
        new Date(ctx.since.getTime() + TOUCH_TOLERANCE_MS)
      ),
    ];
    if (ctx.facetIds.length > 0) {
      facetConditions.push(not(inArray(entityFacets.id, ctx.facetIds)));
    }
    const [roles] = await reader
      .select({ n: count() })
      .from(entityFacets)
      .where(and(...facetConditions));
    if ((roles?.n ?? 0) > 0) {
      return skip(target, "in_use", "the entity was given a new role since");
    }
  }
  return null;
}

async function inspectRelation(
  reader: Reader,
  target: Extract<RevertTarget, { kind: "relation" }>,
  ctx: InspectContext
): Promise<RevertSkip | null> {
  const [row] = await reader
    .select({ sourceProposalId: relations.sourceProposalId })
    .from(relations)
    .where(eq(relations.id, target.id))
    .for("update");
  // Relations are hard-deleted, so an absent row is indistinguishable from
  // one an earlier revert removed. Either way there is nothing left to undo.
  if (!row) return skip(target, "already_reverted", "the link is already gone");
  if (foreignLineage(row.sourceProposalId, ctx)) {
    return skip(target, "not_owned", "the link was created by other work");
  }
  return null;
}

async function inspectFacet(
  reader: Reader,
  target: Extract<RevertTarget, { kind: "facet" }>,
  ctx: InspectContext
): Promise<RevertSkip | null> {
  const [row] = await reader
    .select({
      deletedAt: entityFacets.deletedAt,
      updatedAt: entityFacets.updatedAt,
      sourceProposalId: entityFacets.sourceProposalId,
    })
    .from(entityFacets)
    .where(eq(entityFacets.id, target.id))
    .for("update");
  if (!row) return skip(target, "not_found", "the role no longer exists");
  if (row.deletedAt) {
    return skip(target, "already_reverted", "the role is already removed");
  }
  if (foreignLineage(row.sourceProposalId, ctx)) {
    return skip(target, "not_owned", "the role was attached by other work");
  }
  if (changedAfter(row.updatedAt, ctx.since)) {
    return skip(
      target,
      "edited_since",
      "the role was edited after it was attached"
    );
  }
  return null;
}

async function inspectAutomation(
  reader: Reader,
  target: Extract<RevertTarget, { kind: "automation" }>,
  ctx: InspectContext
): Promise<RevertSkip | null> {
  const [row] = await reader
    .select({ status: automations.status, updatedAt: automations.updatedAt })
    .from(automations)
    .where(eq(automations.id, target.id))
    .for("update");
  if (!row) return skip(target, "not_found", "the automation no longer exists");
  if (row.status === "archived") {
    return skip(
      target,
      "already_reverted",
      "the automation is already archived"
    );
  }
  const [runs] = await reader
    .select({ n: count() })
    .from(automationRuns)
    .where(eq(automationRuns.automationId, target.id));
  if ((runs?.n ?? 0) > 0) {
    return skip(target, "in_use", "the automation has already run");
  }
  // Materialized as a draft, always. Anything else means someone turned it on.
  if (row.status !== "draft" || changedAfter(row.updatedAt, ctx.since)) {
    return skip(
      target,
      "edited_since",
      "the automation was changed after it was created"
    );
  }
  return null;
}

async function inspectSkillRow(
  reader: Reader,
  target: Extract<RevertTarget, { kind: "skill" | "rule" }>,
  ctx: InspectContext
): Promise<RevertSkip | null> {
  const noun = target.kind === "rule" ? "rule" : "skill";
  const [row] = await reader
    .select({ status: skills.status, updatedAt: skills.updatedAt })
    .from(skills)
    .where(eq(skills.id, target.id))
    .for("update");
  if (!row) return skip(target, "not_found", `the ${noun} no longer exists`);
  if (row.status === "inactive") {
    return skip(target, "already_reverted", `the ${noun} is already inactive`);
  }
  if (changedAfter(row.updatedAt, ctx.since)) {
    return skip(
      target,
      "edited_since",
      `the ${noun} was changed after it was created`
    );
  }
  return null;
}

/** A playbook that has RUN is somebody's history; a draft still untouched is not. */
async function inspectPlaybook(
  reader: Reader,
  target: Extract<RevertTarget, { kind: "playbook" }>
): Promise<RevertSkip | null> {
  const [runs] = await reader
    .select({ n: count() })
    .from(playbookRuns)
    .where(eq(playbookRuns.playbookId, target.id));
  if ((runs?.n ?? 0) > 0) {
    return skip(target, "in_use", "the playbook has already run");
  }
  const [row] = await reader
    .select({ id: playbooks.id, status: playbooks.status })
    .from(playbooks)
    .where(eq(playbooks.id, target.id))
    .for("update");
  // Still the draft the promote minted, and still present.
  if (!row || row.status !== "draft") {
    return skip(
      target,
      "in_use",
      "the playbook is no longer the untouched draft"
    );
  }
  return null;
}

/**
 * A project is in use the moment anything ELSE points at it: another session
 * scoped to it, or any link that is not its own lineage edge.
 */
async function inspectProject(
  reader: Reader,
  target: Extract<RevertTarget, { kind: "project" }>,
  ctx: InspectContext
): Promise<RevertSkip | null> {
  const id = target.id;
  const inUse = skip(target, "in_use", "something else uses the project");
  const otherSessionConditions = [eq(focusSessions.projectId, id)];
  if (ctx.sessionId) {
    otherSessionConditions.push(ne(focusSessions.id, ctx.sessionId));
  }
  // Sessions this SAME undo retires (a plan's own sessions) are not a use.
  if (ctx.sessionIds.length > 0) {
    otherSessionConditions.push(not(inArray(focusSessions.id, ctx.sessionIds)));
  }
  const [otherSessions] = await reader
    .select({ n: count() })
    .from(focusSessions)
    .where(and(...otherSessionConditions));
  if ((otherSessions?.n ?? 0) > 0) return inUse;
  const otherLinkConditions = [
    eq(links.toType, "project"),
    eq(links.toId, id),
    ne(links.linkType, "promoted_to"),
  ];
  if (ctx.linkIds.length > 0) {
    otherLinkConditions.push(not(inArray(links.id, ctx.linkIds)));
  }
  const [otherLinks] = await reader
    .select({ n: count() })
    .from(links)
    .where(and(...otherLinkConditions));
  if ((otherLinks?.n ?? 0) > 0) return inUse;
  const outboundConditions = [
    eq(links.fromType, "project"),
    eq(links.fromId, id),
  ];
  const ownSubjectEntityId = target.subjectEntityId ?? ctx.subjectEntityId;
  if (ownSubjectEntityId) {
    // Exclude the subject edge the spawn itself wrote — counting it made every
    // spawn from a subject-bound session unrevertable.
    outboundConditions.push(
      not(
        and(
          eq(links.linkType, "targets"),
          eq(links.toType, "entity"),
          eq(links.toId, ownSubjectEntityId)
        )!
      )
    );
  }
  const [outbound] = await reader
    .select({ n: count() })
    .from(links)
    .where(and(...outboundConditions));
  if ((outbound?.n ?? 0) > 0) return inUse;
  const [row] = await reader
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(eq(projects.id, id))
    .for("update");
  if (!row || row.status !== "active") return inUse;
  return null;
}

async function inspectLink(
  reader: Reader,
  target: Extract<RevertTarget, { kind: "link" }>
): Promise<RevertSkip | null> {
  const [row] = await reader
    .select({ id: links.id })
    .from(links)
    .where(eq(links.id, target.id))
    .for("update");
  // Hard-deleted like a relation: absent means nothing left to undo.
  if (!row) return skip(target, "already_reverted", "the link is already gone");
  return null;
}

async function inspectProperty(
  reader: Reader,
  target: Extract<RevertTarget, { kind: "property" | "entity_body" }>
): Promise<RevertSkip | null> {
  const [row] = await reader
    .select({
      properties: entities.properties,
      documentId: entities.documentId,
      deletedAt: entities.deletedAt,
    })
    .from(entities)
    .where(eq(entities.id, target.entityId))
    .for("update");
  if (!row || row.deletedAt) {
    return skip(target, "not_found", "the entity no longer exists");
  }
  if (target.kind === "entity_body") {
    return row.documentId === target.documentId
      ? null
      : skip(target, "edited_since", "the entity's body was changed since");
  }
  const current = ((row.properties ?? {}) as Record<string, unknown>)[
    target.key
  ];
  return JSON.stringify(current) === JSON.stringify(target.after)
    ? null
    : skip(target, "edited_since", `"${target.key}" was edited since`);
}

async function inspect(
  reader: Reader,
  target: RevertTarget,
  ctx: InspectContext
): Promise<RevertSkip | null> {
  switch (target.kind) {
    case "entity":
      return inspectEntity(reader, target, ctx);
    case "relation":
      return inspectRelation(reader, target, ctx);
    case "facet":
      return inspectFacet(reader, target, ctx);
    case "automation":
      return inspectAutomation(reader, target, ctx);
    case "skill":
    case "rule":
      return inspectSkillRow(reader, target, ctx);
    case "playbook":
      return inspectPlaybook(reader, target);
    case "project":
      return inspectProject(reader, target, ctx);
    case "link":
      return inspectLink(reader, target);
    case "property":
    case "entity_body":
      return inspectProperty(reader, target);
  }
}

/** Links go before the rows they connect; property restores before any delete. */
const APPLY_ORDER: Record<RevertTarget["kind"], number> = {
  relation: 0,
  link: 0,
  facet: 1,
  property: 2,
  entity_body: 3,
  entity: 4,
  rule: 5,
  automation: 6,
  skill: 7,
  playbook: 8,
  project: 9,
};

async function apply(
  tx: RevertTransaction,
  target: RevertTarget,
  ctx: InspectContext
): Promise<void> {
  const now = new Date();
  switch (target.kind) {
    case "relation":
      await tx.delete(relations).where(eq(relations.id, target.id));
      return;
    case "facet":
      await tx
        .update(entityFacets)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(eq(entityFacets.id, target.id), isNull(entityFacets.deletedAt))
        );
      return;
    case "property": {
      const [row] = await tx
        .select({ properties: entities.properties })
        .from(entities)
        .where(eq(entities.id, target.entityId))
        .limit(1);
      const next = { ...((row?.properties ?? {}) as Record<string, unknown>) };
      if (target.absentBefore) delete next[target.key];
      else next[target.key] = target.before;
      await tx
        .update(entities)
        .set({ properties: next, updatedAt: now })
        .where(eq(entities.id, target.entityId));
      return;
    }
    case "entity_body":
      await tx
        .update(entities)
        .set({ documentId: null, updatedAt: now })
        .where(
          and(
            eq(entities.id, target.entityId),
            eq(entities.documentId, target.documentId)
          )
        );
      return;
    case "entity":
      await tx
        .update(entities)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(entities.id, target.id), isNull(entities.deletedAt)));
      if (ctx.sessionId) {
        // The session did not produce it any more.
        await tx
          .delete(links)
          .where(
            and(
              eq(links.fromType, "session"),
              eq(links.fromId, ctx.sessionId),
              eq(links.toType, "entity"),
              eq(links.toId, target.id),
              eq(links.linkType, "produced")
            )
          );
      }
      return;
    case "automation":
      await tx
        .update(automations)
        .set({ status: "archived", updatedAt: now })
        .where(eq(automations.id, target.id));
      return;
    case "skill":
    case "rule":
      await tx
        .update(skills)
        .set({ status: "inactive", updatedAt: now })
        .where(eq(skills.id, target.id));
      return;
    case "playbook":
      await tx
        .update(playbooks)
        .set({ status: "archived", updatedAt: now })
        .where(eq(playbooks.id, target.id));
      return;
    case "project":
      await tx
        .update(projects)
        .set({ status: "archived", updatedAt: now })
        .where(eq(projects.id, target.id));
      return;
    case "link":
      await tx.delete(links).where(eq(links.id, target.id));
      return;
  }
}

export async function safeRevert(
  opts: SafeRevertOptions
): Promise<SafeRevertResult> {
  const database = opts.database ?? db;
  const ctx: InspectContext = {
    since: opts.touchedSince ?? null,
    sourceProposalId: opts.sourceProposalId ?? null,
    relationIds: opts.targets.flatMap((t) =>
      t.kind === "relation" ? [t.id] : []
    ),
    facetIds: opts.targets.flatMap((t) => (t.kind === "facet" ? [t.id] : [])),
    sessionIds: opts.ownSessionIds ?? [],
    linkIds: opts.targets.flatMap((t) => (t.kind === "link" ? [t.id] : [])),
    sessionId: opts.sessionId ?? null,
    subjectEntityId: opts.subjectEntityId ?? null,
    pass: opts.touchedByPass ?? null,
  };

  return database.transaction(async (tx) => {
    // Checked on the transaction, rows locked: nothing can change a target
    // between the verdict and the write.
    const untouched: RevertTarget[] = [];
    const skipped: RevertSkip[] = [];
    for (const target of opts.targets) {
      const refusal = await inspect(tx, target, ctx);
      if (refusal) skipped.push(refusal);
      else untouched.push(target);
    }

    if (opts.mode === "all_or_nothing" && skipped.length > 0) {
      return { reverted: [], skipped };
    }

    const ordered = [...untouched].sort(
      (a, b) => APPLY_ORDER[a.kind] - APPLY_ORDER[b.kind]
    );
    for (const target of ordered) {
      await apply(tx, target, ctx);
    }
    const result: SafeRevertResult = { reverted: ordered, skipped };
    await opts.alsoInTransaction?.(tx, result);
    return result;
  });
}
