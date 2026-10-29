/**
 * Required links — a template's `entityLinks[].required`, read back from
 * `profile_relations.metadata` (`readRequiredLinkMark`, @synap/database) and
 * answered at the doors.
 *
 * Founder decisions (wave e4cd5f18, plan 38fb38a7 §3, research R3 2469006b):
 * D3.2 a missing REQUIRED link WARNS, it never refuses yet; D3.3 a link between
 * two kinds no template declares WARNS, never refuses. The order is
 * warn → list → check → refuse; this module is the WARN and the LIST:
 *   - `checkRequiredLinksForCreate` — the create doors (`entities.create`, the
 *     capture graph): which required links a new record leaves out. The answer
 *     rides the reply (`warnings[]`) and the proposal (`requiredLinks`).
 *   - `undeclaredLinkWarning` — the relation door: an edge whose kind pair no
 *     template declares, for a type its source kind does declare.
 *   - `requiredLinkDebtByWorkspace` — template health: per space and kind, the
 *     rows missing a required link (count + a few ids), the backfill worklist.
 *
 * What it reads: `relations` rows only. A required link of a dependency type
 * (`blocks` / `depends_on`, stored as a `links` row) is never seen as present.
 * Pod-wide records (no workspace) are not counted in any space's debt.
 */

import {
  db,
  and,
  eq,
  inArray,
  isNull,
  drizzleSql,
  entities,
  profiles,
  profileRelations,
  relationDefs,
  readRequiredLinkMark,
} from "@synap/database";
import {
  opRef,
  PRIMARY_REF,
  type CompositeCreateEntityOp,
  type CompositeCreateRelationOp,
  type CompositeProposalOperation,
  type MissingRequiredLink,
  type RequiredLinkCheck,
} from "@synap-core/types/proposals";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "required-links" });

/** One required link of one kind: an edge of `type` to any of the targets. */
export interface RequiredLinkRule {
  sourceProfileId: string;
  kind: string;
  type: string;
  targetProfileIds: string[];
  targetKinds: string[];
  requiredBy: string | null;
}

/** An edge a write carries (or an existing record holds). */
export interface PresentLink {
  type: string;
  /** The target's kind, when known. Unknown = any kind (lenient: warn-only). */
  targetKind?: string | null;
}

type Database = typeof db;

/**
 * The required-link rules whose source kind is one of `sourceProfileIds`
 * (every rule in the pod when omitted). Grouped by (kind, type): a link
 * declared required to `person` and to `company` is ONE rule, met by either.
 */
export async function readRequiredLinkRules(
  sourceProfileIds?: readonly string[],
  database: Database = db
): Promise<RequiredLinkRule[]> {
  if (sourceProfileIds && sourceProfileIds.length === 0) return [];
  const rows = await database
    .select({
      sourceProfileId: profileRelations.sourceProfileId,
      targetProfileId: profileRelations.targetProfileId,
      metadata: profileRelations.metadata,
      type: relationDefs.slug,
    })
    .from(profileRelations)
    .innerJoin(
      relationDefs,
      eq(relationDefs.id, profileRelations.relationDefId)
    )
    .where(
      and(
        drizzleSql`${profileRelations.metadata} ->> 'required' = 'true'`,
        sourceProfileIds
          ? inArray(profileRelations.sourceProfileId, [...sourceProfileIds])
          : undefined
      )
    );
  const marked = rows.flatMap((r) => {
    const mark = readRequiredLinkMark(r.metadata);
    return mark ? [{ ...r, requiredBy: mark.requiredBy }] : [];
  });
  if (marked.length === 0) return [];
  const profileIds = [
    ...new Set(marked.flatMap((r) => [r.sourceProfileId, r.targetProfileId])),
  ];
  const slugRows = await database
    .select({ id: profiles.id, slug: profiles.slug })
    .from(profiles)
    .where(inArray(profiles.id, profileIds));
  const slugOf = new Map(slugRows.map((p) => [p.id, p.slug]));

  const rules = new Map<string, RequiredLinkRule>();
  for (const r of marked) {
    const kind = slugOf.get(r.sourceProfileId);
    const target = slugOf.get(r.targetProfileId);
    if (!kind || !target) continue;
    const key = `${r.sourceProfileId}:${r.type}`;
    const rule = rules.get(key) ?? {
      sourceProfileId: r.sourceProfileId,
      kind,
      type: r.type,
      targetProfileIds: [],
      targetKinds: [],
      requiredBy: null,
    };
    rule.targetProfileIds.push(r.targetProfileId);
    if (!rule.targetKinds.includes(target)) rule.targetKinds.push(target);
    rule.requiredBy ??= r.requiredBy;
    rules.set(key, rule);
  }
  return [...rules.values()].map((rule) => ({
    ...rule,
    targetKinds: [...rule.targetKinds].sort(),
  }));
}

/**
 * The rules `present` leaves unmet. A rule is met by an edge of its type whose
 * target kind is one of its targets, or whose target kind is unknown.
 */
export function missingRequiredLinks(
  rules: readonly RequiredLinkRule[],
  present: readonly PresentLink[]
): MissingRequiredLink[] {
  return rules
    .filter(
      (rule) =>
        !present.some(
          (edge) =>
            edge.type === rule.type &&
            (!edge.targetKind || rule.targetKinds.includes(edge.targetKind))
        )
    )
    .map((rule) => ({
      kind: rule.kind,
      type: rule.type,
      targetKinds: rule.targetKinds,
      requiredBy: rule.requiredBy,
    }));
}

/** The check's answer from the missing links found. */
export function requiredLinkCheckOf(
  missing: MissingRequiredLink[]
): RequiredLinkCheck {
  return { status: missing.length ? "missing" : "clear", missing };
}

/**
 * The required links a NEW record of `kind` leaves out, given the edges the
 * same write carries (`present`; a plain create carries none). Read by kind
 * SLUG, like the graph check: the create door and the reconcile may resolve
 * different rows of one kind (a workspace copy), and either row's mark
 * counts. Never throws: a failed read is `unchecked`, never `clear`.
 */
export async function checkRequiredLinksForCreate(params: {
  kind: string | null | undefined;
  present?: readonly PresentLink[];
  database?: Database;
}): Promise<RequiredLinkCheck> {
  if (!params.kind) return { status: "clear", missing: [] };
  try {
    const rules = await readRequiredLinkRulesForKinds(
      [params.kind],
      params.database
    );
    return requiredLinkCheckOf(
      dedupeMissing(missingRequiredLinks(rules, params.present ?? []))
    );
  } catch (err) {
    logger.warn({ err, kind: params.kind }, "required-link check failed");
    return { status: "unchecked", missing: [] };
  }
}

/** The required-link rules of every kind named in `kinds` (by slug). */
export async function readRequiredLinkRulesForKinds(
  kinds: readonly string[],
  database: Database = db
): Promise<RequiredLinkRule[]> {
  if (kinds.length === 0) return [];
  const rows = await database
    .select({ id: profiles.id })
    .from(profiles)
    .where(inArray(profiles.slug, [...new Set(kinds)]));
  return readRequiredLinkRules(
    rows.map((r) => r.id),
    database
  );
}

/**
 * A capture graph's answer: for each NEW record (a `create_entity` op that
 * links no existing entity), the required links of its kind that no
 * `create_relation` of the SAME graph sources from it. An edge to an op of the
 * graph knows its target's kind; an edge to an existing id (a UUID) does not
 * and counts for any kind. Never throws: a failed read is `unchecked`.
 */
export async function checkRequiredLinksForGraph(
  operations: readonly CompositeProposalOperation[],
  database: Database = db
): Promise<RequiredLinkCheck> {
  const creates = operations.filter(
    (op): op is CompositeCreateEntityOp =>
      op.op === "create_entity" && !op.existingEntityId
  );
  if (creates.length === 0) return { status: "clear", missing: [] };
  // Every name an op answers to in a relation: its ref, `$opN` (N = its index
  // among ALL create_entity ops) and PRIMARY_REF for the first one.
  const allCreates = operations.filter(
    (op): op is CompositeCreateEntityOp => op.op === "create_entity"
  );
  const kindOfRef = new Map<string, string>();
  allCreates.forEach((op, i) => {
    if (op.ref) kindOfRef.set(op.ref, op.profileSlug);
    kindOfRef.set(opRef(i), op.profileSlug);
    if (i === 0) kindOfRef.set(PRIMARY_REF, op.profileSlug);
  });
  const namesOf = (op: CompositeCreateEntityOp): string[] => {
    const i = allCreates.indexOf(op);
    return [
      ...(op.ref ? [op.ref] : []),
      opRef(i),
      ...(i === 0 ? [PRIMARY_REF] : []),
    ];
  };
  const edges = operations.filter(
    (op): op is CompositeCreateRelationOp => op.op === "create_relation"
  );
  try {
    const rules = await readRequiredLinkRulesForKinds(
      creates.map((op) => op.profileSlug),
      database
    );
    const missing = creates.flatMap((op) => {
      const names = namesOf(op);
      const present = edges
        .filter((e) => names.includes(e.sourceRef))
        .map((e) => ({
          type: e.type,
          targetKind: kindOfRef.get(e.targetRef) ?? null,
        }));
      return dedupeMissing(
        missingRequiredLinks(
          rules.filter((r) => r.kind === op.profileSlug),
          present
        )
      ).map((m) => ({
        ...m,
        ...(op.ref ? { forRef: op.ref } : {}),
        ...(op.title ? { forTitle: op.title } : {}),
      }));
    });
    return requiredLinkCheckOf(missing);
  } catch (err) {
    logger.warn({ err }, "required-link check of a capture graph failed");
    return { status: "unchecked", missing: [] };
  }
}

/** One entry per (kind, type): workspace copies of a kind share a rule. */
function dedupeMissing(missing: MissingRequiredLink[]): MissingRequiredLink[] {
  const byKey = new Map<string, MissingRequiredLink>();
  for (const m of missing) {
    const key = `${m.kind}:${m.type}`;
    const prior = byKey.get(key);
    byKey.set(
      key,
      prior
        ? {
            ...prior,
            targetKinds: [
              ...new Set([...prior.targetKinds, ...m.targetKinds]),
            ].sort(),
            requiredBy: prior.requiredBy ?? m.requiredBy,
          }
        : m
    );
  }
  return [...byKey.values()];
}

/**
 * The warning for an edge whose kind pair no template declares, when its
 * SOURCE kind declares links of this type to other kinds (`outreach-touch`
 * declares `sent_to` → `person`, so `sent_to` → `company` warns). A kind that
 * declares no link of this type gets no warning: generic edges between free
 * kinds (a note `relates_to` a person) stay quiet. Matched on kind slugs, so a
 * workspace copy of a kind counts as the kind. `null` = nothing to say.
 * Throws on a failed read; the door decides what a failure means.
 */
export async function undeclaredLinkWarning(params: {
  type: string;
  sourceEntityId: string;
  targetEntityId: string;
  database?: Database;
}): Promise<string | null> {
  const database = params.database ?? db;
  const endpoints = await database
    .select({ id: entities.id, kind: profiles.slug })
    .from(entities)
    .innerJoin(profiles, eq(profiles.id, entities.profileId))
    .where(
      inArray(entities.id, [params.sourceEntityId, params.targetEntityId])
    );
  const sourceKind = endpoints.find(
    (e) => e.id === params.sourceEntityId
  )?.kind;
  const targetKind = endpoints.find(
    (e) => e.id === params.targetEntityId
  )?.kind;
  if (!sourceKind || !targetKind) return null;

  const declared = await database
    .select({ targetProfileId: profileRelations.targetProfileId })
    .from(profileRelations)
    .innerJoin(
      relationDefs,
      eq(relationDefs.id, profileRelations.relationDefId)
    )
    .innerJoin(profiles, eq(profiles.id, profileRelations.sourceProfileId))
    .where(
      and(eq(relationDefs.slug, params.type), eq(profiles.slug, sourceKind))
    );
  if (declared.length === 0) return null;
  const targetRows = await database
    .select({ slug: profiles.slug })
    .from(profiles)
    .where(
      inArray(
        profiles.id,
        declared.map((d) => d.targetProfileId)
      )
    );
  const targets = [...new Set(targetRows.map((t) => t.slug))].sort();
  if (targets.length === 0 || targets.includes(targetKind)) return null;
  return (
    `No template declares a ${params.type} link from ${sourceKind} to ${targetKind} ` +
    `(${sourceKind} declares ${params.type} to ${targets.join(" or ")}). ` +
    `The link was written; check it is the one you meant.`
  );
}

/** The relation door's sentence when the declared-link read failed. */
export const UNDECLARED_LINK_UNCHECKED_WARNING =
  "Whether a template declares this link could not be checked.";

/** Per space and kind: the rows missing one required link. */
export interface RequiredLinkDebt {
  kind: string;
  type: string;
  targetKinds: string[];
  requiredBy: string | null;
  /** How many live rows of the kind in this space lack the link. */
  count: number;
  /** Up to `sample` of them, newest first. */
  entityIds: string[];
}

export const REQUIRED_LINK_DEBT_SAMPLE = 5;

/** Template health's line when the required-link debt could not be read. */
export const REQUIRED_LINK_DEBT_UNCHECKED_WARNING =
  "The records missing a required link could not be counted.";

/** The health sentence for one debt row. */
export function requiredLinkDebtWarning(debt: RequiredLinkDebt): string {
  const rows = debt.count === 1 ? "1 record" : `${debt.count} records`;
  const by = debt.requiredBy
    ? `required by template ${debt.requiredBy}`
    : "required by its template";
  return `${rows} of ${debt.kind} have no ${debt.type} to ${debt.targetKinds.join(" or ")}: ${by}.`;
}

/**
 * Template health's LIST: for each space in `workspaceIds`, the live rows of a
 * kind with a required link that carry no edge of that type to a live record
 * of a target kind. Throws on a failed read (health reports it as unchecked).
 */
export async function requiredLinkDebtByWorkspace(
  workspaceIds: readonly string[],
  database: Database = db,
  sample: number = REQUIRED_LINK_DEBT_SAMPLE
): Promise<Map<string, RequiredLinkDebt[]>> {
  const out = new Map<string, RequiredLinkDebt[]>();
  if (workspaceIds.length === 0) return out;
  const rules = await readRequiredLinkRules(undefined, database);
  const limit = Math.max(1, Math.floor(sample));
  for (const rule of rules) {
    const targetIds = drizzleSql.join(
      rule.targetProfileIds.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql`, `
    );
    const rows = await database
      .select({
        workspaceId: entities.workspaceId,
        count: drizzleSql<number>`count(*)::int`,
        ids: drizzleSql<
          string[]
        >`(array_agg(${entities.id} order by ${entities.createdAt} desc))[1:${drizzleSql.raw(String(limit))}]`,
      })
      .from(entities)
      .where(
        and(
          inArray(entities.workspaceId, [...workspaceIds]),
          eq(entities.profileId, rule.sourceProfileId),
          isNull(entities.deletedAt),
          drizzleSql`not exists (
            select 1 from relations r
            join entities t on t.id = r.target_entity_id
            where r.source_entity_id = ${entities.id}
              and r.type = ${rule.type}
              and t.deleted_at is null
              and t.profile_id in (${targetIds})
          )`
        )
      )
      .groupBy(entities.workspaceId);
    for (const row of rows) {
      if (!row.workspaceId || Number(row.count) === 0) continue;
      const list = out.get(row.workspaceId) ?? [];
      list.push({
        kind: rule.kind,
        type: rule.type,
        targetKinds: rule.targetKinds,
        requiredBy: rule.requiredBy,
        count: Number(row.count),
        entityIds: row.ids ?? [],
      });
      out.set(row.workspaceId, list);
    }
  }
  return out;
}
