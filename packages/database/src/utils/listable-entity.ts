/**
 * THE LISTING RULE — which entities a LISTING shows (FB1020 B5).
 *
 * A listing is any read that answers "what is there?": a list, a count, a
 * search, a view, recall, graph neighbours, a dashboard. Two kinds of rows are
 * real data that no listing should show by default:
 *
 *   - PROBE rows (D8) — written by an explicitly declared probe key, marked
 *     `systemData.probe` at the write floor (request-write-context.ts).
 *   - SAMPLE rows — demo data: an entity filed into a SAMPLE project
 *     (`projects.sample`, 0347) via `belongs_to_project`, or a sample project's
 *     SUBJECT (`project --targets--> entity`, utils/project-subject.ts in
 *     @synap/api), and filed into NO non-sample project. Real membership wins:
 *     a real record wrongly filed into a demo stays visible (hiding real data
 *     is the worse failure).
 *
 * NOT ACCESS. Both stay readable and editable BY ID — this rule is composed at
 * listing doors next to the access floor, never inside it (the floor is also
 * read by by-id gets, write targeting and dedup). It mirrors
 * `notInAnyProjectWhere` (@synap/api utils/project-scope.ts): one predicate,
 * every listing door reads it, so a count of N opens a list of N.
 *
 * THE TOGGLE IS THE PROJECT LENS. With a project lens set, the sample half is
 * OFF: the lens already narrows to that project's members, and a member of a
 * real project is real by definition — so opening the demo project shows the
 * demo and nothing else changes. There is no global "show demo" switch to
 * forget before a screenshot. Probe rows stay hidden under every lens.
 *
 * Only edges to a LIVE `projects` row count (projects are hard-deleted and
 * their edges left behind): a record whose sample project was deleted is no
 * longer sample.
 *
 * Lives in @synap/database (not beside `notInAnyProjectWhere` in @synap/api)
 * because the automation matcher in @synap/jobs reads the SAME definition
 * (`sampleProjectIdsOfEntity`), and @synap/api depends on @synap/jobs.
 *
 * ROW SHAPE: the predicates reference `entities.id` / `entities.system_data`
 * directly, so they apply to a query whose FROM is the `entities` table
 * (unaliased). A door reading entities through an alias or a subquery must
 * semi-join `entities` instead.
 */

import {
  and,
  eq,
  inArray,
  isNotNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "../client-pg.js";
import { entities } from "../schema/entities.js";
import { projects } from "../schema/projects.js";
import { relations } from "../schema/relations.js";
import { links } from "../schema/links.js";
import { notProbeEntityWhere } from "./request-write-context.js";
import { BELONGS_TO_PROJECT } from "./entity-project-membership.js";
import type { getDb } from "../client-pg.js";

/**
 * The `entities` row is filed into (or is the subject of) a live project whose
 * `sample` flag is `sample`. UNCORRELATED subqueries on purpose: a relational
 * read (`db.query.entities.findMany`) re-aliases every column inside a raw
 * `sql` chunk to the root table, so a correlated `EXISTS` written in raw SQL
 * would break there; subquery builders render identically under `db.select()`
 * and `db.query` (the same convention as facet-visibility.ts).
 */
function memberOfProjectWhere(sample: boolean): SQL {
  const filed = db
    .select({ id: relations.sourceEntityId })
    .from(relations)
    .innerJoin(projects, eq(projects.id, relations.targetEntityId))
    .where(
      and(
        eq(relations.type, BELONGS_TO_PROJECT),
        // NOT IN over a NULL would hide every row.
        isNotNull(relations.sourceEntityId),
        eq(projects.sample, sample)
      )
    );
  const subjectOf = db
    .select({ id: links.toId })
    .from(links)
    .innerJoin(projects, eq(sql`${projects.id}::text`, links.fromId))
    .where(
      and(
        eq(links.fromType, "project"),
        eq(links.toType, "entity"),
        eq(links.linkType, "targets"),
        eq(projects.sample, sample)
      )
    );
  return or(
    inArray(entities.id, filed),
    inArray(sql`${entities.id}::text`, subjectOf)
  )!;
}

/**
 * The `entities` row is SAMPLE (demo) data: in a live sample project and in
 * no live non-sample project. Use `listableEntityWhere` at a listing door;
 * this half alone is for doors that must ASK the question (the matcher).
 */
export function sampleEntityWhere(): SQL {
  return sql`(${memberOfProjectWhere(true)} AND NOT ${memberOfProjectWhere(false)})`;
}

export interface ListableEntityOptions {
  /**
   * The listing's project lens. Set (an id or a non-empty set) ⇒ the sample
   * half is off — the lens is the toggle. `undefined`/`null`/`[]` ⇒ demo
   * rows are left out.
   */
  projectLens?: string | readonly string[] | null;
}

/**
 * THE listing predicate. AND it with the access floor at every door that
 * lists or counts entities; never at a by-id read, a write target or dedup.
 */
export function listableEntityWhere(opts: ListableEntityOptions = {}): SQL {
  const lens = opts.projectLens;
  const lensed = Array.isArray(lens)
    ? lens.length > 0
    : typeof lens === "string" && lens.length > 0;
  return lensed
    ? notProbeEntityWhere()
    : sql`(${notProbeEntityWhere()} AND NOT ${sampleEntityWhere()})`;
}

/**
 * The ids the listing rule leaves out (probe + demo rows; with a project lens,
 * probe rows only) — as an uncorrelated subquery, for listing doors whose FROM
 * is NOT `entities` (facets, relations, links, vectors):
 * `not(inArray(table.entityId, unlistableEntityIds()))`. Small by design (it
 * selects the exceptions, never every entity), and `entities.id` is NOT NULL,
 * so the NOT IN is safe.
 */
export function unlistableEntityIds(opts: ListableEntityOptions = {}) {
  return db
    .select({ id: entities.id })
    .from(entities)
    .where(not(listableEntityWhere(opts)));
}

/**
 * The sample projects an entity is demo data OF — empty when the entity is
 * real (in no sample project, or also in a non-sample one). For doors that
 * must decide per entity rather than filter a listing (the automation
 * matcher: a sample record fires only rules scoped to these projects).
 *
 * Throws on a failed read; the caller decides its own failure mode.
 */
export async function sampleProjectIdsOfEntity(
  db: Awaited<ReturnType<typeof getDb>>,
  entityId: string
): Promise<ReadonlySet<string>> {
  const columns = { id: projects.id, sample: projects.sample };
  const viaFiling = await db
    .select(columns)
    .from(relations)
    .innerJoin(projects, eq(projects.id, relations.targetEntityId))
    .where(
      and(
        eq(relations.sourceEntityId, entityId),
        eq(relations.type, BELONGS_TO_PROJECT)
      )
    );
  const viaSubject = await db
    .select(columns)
    .from(links)
    .innerJoin(projects, eq(sql`${projects.id}::text`, links.fromId))
    .where(
      and(
        eq(links.toType, "entity"),
        eq(links.toId, entityId),
        eq(links.fromType, "project"),
        eq(links.linkType, "targets")
      )
    );
  const list = [...viaFiling, ...viaSubject];
  return classifySampleMembership(list);
}

/**
 * PURE — the sample half of the rule over an entity's live project rows:
 * the sample project ids when EVERY membership is sample, else empty.
 * `sampleEntityWhere` is its SQL twin; the pglite test pins them together.
 */
export function classifySampleMembership(
  memberships: ReadonlyArray<{ id: string; sample: boolean | null }>
): ReadonlySet<string> {
  if (memberships.length === 0) return new Set();
  if (memberships.some((m) => m.sample !== true)) return new Set();
  return new Set(memberships.map((m) => m.id));
}
