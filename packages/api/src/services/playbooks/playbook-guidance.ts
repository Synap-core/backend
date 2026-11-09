/**
 * The rules a playbook follows, resolved for ONE reader (design b199a3a4,
 * slice 1a). A playbook declares `guidance` as refs (`kind:<slug>`,
 * `skill:<slug>`, `@synap-core/types/guidance`); this loader turns each ref into
 * its CURRENT, person-approved versions and hands them to the ONE pure
 * renderer (`renderGuidance`). The method renderer (`playbook-method.ts`) puts
 * the result under "Rules this playbook follows" on every door.
 *
 * WHAT RENDERS (security: this text becomes prompt text):
 *   - a kind ref: the entities of that kind whose lifecycle CATEGORY is `done`
 *     (the kind's approved option, e.g. a voice guide `approved`), not deleted,
 *     that the reader may read (`accessScopeWhere`, the entity floor) and that
 *     a listing shows (`listableEntityWhere`: no probe or demo row). A draft
 *     (`open`) or a retired version (`lost`) never renders. A kind that
 *     declares no lifecycle has no approved version, so it renders nothing and
 *     the section says so.
 *   - a skill ref: the skill with that slug that is `approved` AND `active`,
 *     visible to the reader. An agent-authored skill is born unapproved, so it
 *     never reaches a prompt without a person's OK (the context skill's rule,
 *     `loadPlaybookContextSkill`).
 * Only a TRIAL override (slice 1b's rule lab) renders a draft, in place of a
 * current version it names, and the run records it as `replaces`.
 */

import {
  getDb,
  entities,
  playbooks,
  playbookRuns,
  profiles,
  skills,
  and,
  eq,
  inArray,
  isNull,
  or,
  drizzleSql,
  ProfileResolutionService,
  listableEntityWhere,
} from "@synap/database";
import {
  parseGuidanceRef,
  renderGuidance,
  validateGuidanceDeclaration,
  type GuidanceDeclaration,
  type GuidanceField,
  type GuidanceRow,
  type GuidanceSnapshot,
  type GuidanceUsed,
  type RenderedGuidance,
  type ResolvedGuidance,
} from "@synap-core/types/guidance";
import { resolvePropertyLabel } from "@synap-core/types/property-render";
import { spaceSkillSlugCandidates } from "@synap-core/types/space-brief";
import { accessScopeWhere } from "../../utils/project-scope.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

/** Whose eyes the rules are read with: the run's acting user. */
export interface GuidanceLens {
  userId: string;
}

/**
 * A trial's substitution (slice 1b): `{ <current entity id>: <draft entity
 * id> }`. The draft renders in place of the current version, whatever its
 * status, if it is the same kind and the reader may read it.
 */
export type GuidanceOverride = Readonly<Record<string, string>>;

/** At most this many current versions of one kind are read. */
const MAX_ROWS_PER_KIND = 50;

/** The property an ordered kind sorts its rows by. */
const ORDER_PROPERTY = "order";

type Db = Awaited<ReturnType<typeof getDb>>;

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((v) => ["string", "number", "boolean"].includes(typeof v))
      .map((v) => String(v).trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

function orderOf(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** `where` keeps an entity whose property holds one of the listed values. */
function matchesWhere(
  props: Record<string, unknown>,
  where: GuidanceDeclaration["where"]
): boolean {
  if (!where) return true;
  return Object.entries(where).every(([slug, allowed]) => {
    const v = props[slug];
    const values = Array.isArray(v) ? v : [v];
    return values.some((x) => typeof x === "string" && allowed.includes(x));
  });
}

async function resolveKind(
  database: Db,
  declaration: GuidanceDeclaration,
  slug: string,
  lens: GuidanceLens,
  override: GuidanceOverride | undefined
): Promise<ResolvedGuidance> {
  const kindRows = await database
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.slug, slug));
  if (kindRows.length === 0) {
    return {
      declaration,
      rows: [],
      missingReason: `this pod has no kind named ${slug}`,
    };
  }
  const profileIds = kindRows.map((k) => k.id);
  const resolver = new ProfileResolutionService(database as never);
  const lifecycle = await resolver.getEffectiveLifecycle(profileIds[0]!);
  if (!lifecycle) {
    return {
      declaration,
      rows: [],
      missingReason:
        "this kind declares no lifecycle, so no version of it is approved",
    };
  }
  // The kind's properties in the ONE total order (`getEffectiveProperties`
  // sorts layer, then display order, then slug): a field's position is its
  // index there. The lifecycle property and `order` are not rendered.
  const props = await resolver.getEffectiveProperties(profileIds[0]!);
  const declared = new Map(
    props
      .map((p, position) => ({ p, position }))
      .filter(({ p }) => !p.isLifecycle && p.slug !== ORDER_PROPERTY)
      .map(({ p, position }) => [
        p.slug,
        { label: resolvePropertyLabel(p), position },
      ])
  );

  const floor = accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId: lens.userId,
  });
  const columns = {
    id: entities.id,
    title: entities.title,
    version: entities.version,
    properties: entities.properties,
  };
  const current = await database
    .select(columns)
    .from(entities)
    .where(
      and(
        inArray(entities.profileId, profileIds),
        isNull(entities.deletedAt),
        // THE trust line: only the approved (`done`) version renders.
        eq(entities.statusCategory, "done"),
        floor,
        // THE listing rule: a probe or demo row is never a rule anyone set.
        listableEntityWhere()
      )
    )
    .orderBy(entities.id)
    .limit(MAX_ROWS_PER_KIND);

  // A trial's drafts, read with the same floor and kind, any status.
  const draftIds = override
    ? current.map((r) => override[r.id]).filter((x): x is string => !!x)
    : [];
  const drafts = draftIds.length
    ? await database
        .select(columns)
        .from(entities)
        .where(
          and(
            inArray(entities.id, draftIds),
            inArray(entities.profileId, profileIds),
            isNull(entities.deletedAt),
            floor
          )
        )
    : [];
  const draftById = new Map(drafts.map((d) => [d.id, d]));

  const rows: GuidanceRow[] = [];
  for (const cur of current) {
    const draftId = override?.[cur.id];
    const draft = draftId ? draftById.get(draftId) : undefined;
    const e = draft ?? cur;
    const properties = (e.properties ?? {}) as Record<string, unknown>;
    if (!matchesWhere(properties, declaration.where)) continue;
    const fields: GuidanceField[] = [];
    for (const [key, raw] of Object.entries(properties)) {
      const def = declared.get(key);
      const value = def ? textOf(raw) : null;
      if (def && value) {
        fields.push({ key, label: def.label, value, position: def.position });
      }
    }
    rows.push({
      id: e.id,
      title: e.title ?? "",
      version: String(e.version),
      order: orderOf(properties[ORDER_PROPERTY]),
      fields,
      ...(draft ? { replaces: cur.id } : {}),
    });
  }
  return rows.length > 0
    ? { declaration, rows }
    : { declaration, rows, missingReason: "no approved version yet" };
}

async function resolveSkill(
  database: Db,
  declaration: GuidanceDeclaration,
  slug: string,
  lens: GuidanceLens
): Promise<ResolvedGuidance> {
  const candidates = spaceSkillSlugCandidates(slug);
  const found = await database
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      body: skills.body,
      version: skills.version,
    })
    .from(skills)
    .where(
      and(
        inArray(skills.slug, candidates),
        // THE trust line: a person approved it, and it is in use.
        eq(skills.approved, true),
        eq(skills.status, "active"),
        or(
          eq(skills.userId, lens.userId),
          userVisibleWhere(skills.workspaceId, lens.userId)
        )
      )
    );
  // The ref as written wins over its `system/` form.
  const skill =
    found.find((s) => s.slug === slug) ??
    found.find((s) => s.body?.trim()) ??
    null;
  if (!skill || !skill.body?.trim()) {
    return {
      declaration,
      rows: [],
      missingReason: `no approved skill named ${slug}`,
    };
  }
  return {
    declaration,
    rows: [
      {
        id: skill.id,
        title: skill.name,
        version: skill.version ?? null,
        order: null,
        fields: [],
        body: skill.body,
      },
    ],
  };
}

/**
 * Resolve a declared list for one reader. THROWS on a failed read: the caller
 * decides (the method doors say so in the section, never an empty one).
 */
export async function resolveGuidance(
  declared: readonly unknown[],
  lens: GuidanceLens,
  override?: GuidanceOverride
): Promise<ResolvedGuidance[]> {
  const database = await getDb();
  const out: ResolvedGuidance[] = [];
  for (const raw of declared) {
    const invalid = validateGuidanceDeclaration(raw);
    const declaration = raw as GuidanceDeclaration;
    const ref = invalid ? null : parseGuidanceRef(declaration.ref);
    if (!ref) {
      // Stored before the write door checked, or edited by hand: named, never
      // guessed and never silently dropped.
      out.push({
        declaration: { ref: String((raw as { ref?: unknown })?.ref ?? "?") },
        rows: [],
        missingReason: invalid ?? "not a guidance ref",
      });
      continue;
    }
    out.push(
      ref.type === "kind"
        ? await resolveKind(database, declaration, ref.slug, lens, override)
        : await resolveSkill(database, declaration, ref.slug, lens)
    );
  }
  return out;
}

/**
 * THE loader: a playbook's declared guidance, resolved for `lens` and
 * rendered. `declared` is `[]` and the text `""` when it declares none.
 * THROWS on a failed read.
 */
export async function loadPlaybookGuidance(
  playbookId: string,
  lens: GuidanceLens,
  override?: GuidanceOverride
): Promise<{ declared: unknown[]; rendered: RenderedGuidance }> {
  const database = await getDb();
  const [row] = await database
    .select({ guidance: playbooks.guidance })
    .from(playbooks)
    .where(eq(playbooks.id, playbookId))
    .limit(1);
  const declared = Array.isArray(row?.guidance)
    ? (row.guidance as unknown[])
    : [];
  if (declared.length === 0) {
    return { declared, rendered: renderGuidance([]) };
  }
  const items = await resolveGuidance(declared, lens, override);
  return { declared, rendered: renderGuidance(items) };
}

/**
 * Stamp what a run USED into its definition snapshot, next to the declared
 * refs `buildDefinitionSnapshot` wrote: `guidance: { declared, status, hash,
 * used, demoted, missing }`. The pod stamps this; the AI never reports which
 * rule it used.
 */
export async function recordRunGuidance(
  runId: string,
  snapshot: GuidanceSnapshot
): Promise<void> {
  const database = await getDb();
  await database
    .update(playbookRuns)
    .set({
      definitionSnapshot: drizzleSql`coalesce(${playbookRuns.definitionSnapshot}, '{}'::jsonb) || jsonb_build_object('guidance', coalesce(${playbookRuns.definitionSnapshot} -> 'guidance', '{}'::jsonb) || ${JSON.stringify(snapshot)}::jsonb)`,
    })
    .where(eq(playbookRuns.id, runId));
}

/**
 * What a send drafted in a playbook run carries (slice 1b): the rules the run
 * USED, copied from its definition snapshot by the POD when the send is filed
 * (`proposals.data.guidance`) and kept on the sent message
 * (`messages.metadata.guidance`). The AI never reports it. `unavailable` = the
 * run could not read its rules, or the send could not read the run: said, never
 * an absent stamp that would read as "no rules".
 */
export type SendGuidanceStamp =
  | {
      status: "ok";
      runId: string;
      playbookId: string | null;
      /** The rendered section's hash (`GuidanceSnapshot.hash`). */
      hash: string | null;
      /** Each rule's ref, label, content hash and row ids + versions. */
      used: GuidanceUsed[];
    }
  | { status: "unavailable"; runId: string | null; error: string };

/**
 * The guidance stamp of a send made in `sessionId`: the rules its LATEST
 * playbook run used, or null when the session is no run, or its run used no
 * rule. THROWS on a failed read (the send door stamps `unavailable`).
 */
export async function readSendGuidance(
  sessionId: string
): Promise<SendGuidanceStamp | null> {
  const database = await getDb();
  const [run] = await database
    .select({
      id: playbookRuns.id,
      playbookId: playbookRuns.playbookId,
      snapshot: playbookRuns.definitionSnapshot,
    })
    .from(playbookRuns)
    .where(eq(playbookRuns.sessionId, sessionId))
    .orderBy(drizzleSql`${playbookRuns.startedAt} desc`)
    .limit(1);
  if (!run) return null;
  const g = (run.snapshot as { guidance?: unknown } | null)?.guidance as
    (Partial<GuidanceSnapshot> & { status?: unknown }) | undefined;
  if (!g || typeof g !== "object") return null;
  if (g.status === "unavailable") {
    return {
      status: "unavailable",
      runId: run.id,
      error:
        typeof (g as { error?: unknown }).error === "string"
          ? (g as { error: string }).error
          : "the run could not read its rules",
    };
  }
  if (g.status !== "ok") return null;
  const used = Array.isArray((g as { used?: unknown }).used)
    ? ((g as { used: unknown[] }).used as GuidanceUsed[])
    : [];
  if (used.length === 0) return null;
  return {
    status: "ok",
    runId: run.id,
    playbookId: run.playbookId ?? null,
    hash: typeof g.hash === "string" ? g.hash : null,
    used,
  };
}
