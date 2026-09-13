/**
 * Config Settings store — the ONE door for `config_settings` writes/reads and
 * the guideline RESOLVER.
 *
 * MIRRORS the governance layer (`resolve-agent-governance-decision.ts` +
 * `governance-rules.ts` router): a small additive per-granularity store read by
 * a specificity-ranking resolver. `db` is INJECTED (like `resolveGovernanceRule`)
 * so the caller's connection — and a test's mock — flow straight through.
 *
 * The resolver, `resolveGuidelines`, is the 4th copy of the additive-specificity
 * resolver already written 3× (profile-resolution's `{...base, ...profileLayer,
 * ...overlay}`, governance-rules' rung-2.8 scorer, property-def scoping). Here the
 * layers are the scope granularities (default < workKind < channelType < bridge <
 * channel < shape); it returns the applicable guideline texts ordered most-general →
 * most-specific, so a specific guideline reinforces/overrides a general one when
 * they are concatenated into the interpret prompt.
 */

import { and, eq, isNull, or, sql, desc } from "drizzle-orm";
import { configSettings } from "../schema/config-settings.js";
import type {
  ConfigScopeKind,
  ConfigSetting,
  GuidelineValue,
} from "../schema/config-settings.js";
import type { MessageShapePredicate } from "../schema/automations.js";
import { matchMessageShape, type MessageEnvelope } from "./message-shape.js";

/** The injected Drizzle handle. Type-only reference — never loads the pg client. */
type DbHandle = typeof import("../client-pg.js").db;

/** The setting key this wave writes/reads. The table itself is general. */
export const GUIDELINE_KEY = "guideline";

/**
 * MIRROR — the AUTHORED list is `GUIDELINE_SOURCE_KINDS` in
 * `@synap-core/types/guidelines` (what browser and relay import). This package
 * cannot import it (`@synap-core/types` depends on `@synap/database`), so this
 * runtime copy is pinned identical by `guideline-vocabulary-parity.test.ts`.
 * Change it THERE first.
 *
 * The closed `sourceKind` vocabulary for NON-import inputs — the kinds of input
 * a capture door accepts. An import item's kind is `import:<source>`, where
 * `<source>` is an `IMPORT_SOURCE_VALUES` token (@synap/types — gated at the
 * write door, `routers/guidelines.ts`, since this package does not depend on
 * @synap/types).
 */
export const GUIDELINE_SOURCE_KINDS = [
  "text",
  "url",
  "image",
  "file",
  "audio",
] as const;
export type GuidelineSourceKind = (typeof GUIDELINE_SOURCE_KINDS)[number];

/** The `sourceKind` prefix for import items: `import:<IMPORT_SOURCE_VALUES>`. */
export const IMPORT_SOURCE_KIND_PREFIX = "import:";

/**
 * THE ordering authority: scope kinds general → specific. Rank is the INDEX, so
 * inserting a rung renumbers everything after it automatically and no second
 * hand-maintained table can fall behind (the enum's own declaration order is
 * arbitrary — see `configScopeKindEnum`).
 *
 * WHERE `workKind` SITS, AND WHY — a decision nobody can reconstruct from the
 * code alone, so it is recorded here.
 *
 * The five original rungs form a TRANSPORT ladder: they narrow by where a
 * message came from, and each contains the next (a channel is inside a
 * channelType). `workKind` is on a DIFFERENT AXIS — it narrows by what kind of
 * work is happening — so it is not orderable against the transport rungs by
 * containment: `channel: #ops` and `workKind: credential` each cover situations
 * the other does not. A linear ladder still has to place it, so the placement is
 * a choice about WHO WINS when both match, and it is made this way:
 *
 *   a workKind guideline applies to every situation of that work class,
 *   ACROSS all channels and bridges — a broader situation set than any single
 *   transport rung. An operator instruction bound to one channel ("on this
 *   bridge use Proton, not Drive") is the more local, more operational
 *   override and must therefore be applied LAST. So `workKind` sits directly
 *   above `default` and below every transport rung.
 *
 * THE `workKind` VOCABULARY IS CLOSED, and closed to ONE vocabulary:
 * `scopeRef` holds a `BLOCKED_REASONS` value (@synap/playbooks —
 * credential | permission | capability | policy | decision | physical),
 * enforced at the write door (`routers/guidelines.ts`), which is the only
 * producer. It is NOT a free-text tag: `scopeRef` carries no discriminator, so
 * a SECOND vocabulary sharing this rung would be indistinguishable from the
 * first, which is exactly the untyped-`appliesTo` failure this rung replaces.
 * A different work vocabulary gets its OWN rung and its own context field —
 * never a second namespace here.
 *
 * WHERE THE DATA-TYPE RUNGS SIT (`sourceKind`, `entityKind` — 0258), AND WHY.
 *
 * They are a THIRD axis: what is being STRUCTURED (the input's kind, the
 * output's kind). Like `workKind`, a data-type guideline ("from a screenshot,
 * read prices literally"; "a person needs a LinkedIn URL") applies ACROSS every
 * channel and bridge, so by the same argument it is broader than any transport
 * rung and sits below them. Between the two: the input kind describes the whole
 * capture, the entity kind narrows to one thing extracted from it, so
 * `sourceKind` < `entityKind`. Both sit above `workKind`, which is about
 * blocked WORK rather than about structuring and never co-occurs with them in
 * one call today.
 *
 * VOCABULARIES: `sourceKind` refs are `GUIDELINE_SOURCE_KINDS` or
 * `import:<IMPORT_SOURCE_VALUES>`, and `entityKind` refs are profile slugs, both
 * gated at the write door. Two rungs, not one `dataType` rung with a prefix,
 * for the reason recorded above: one `scopeRef` must never carry two
 * vocabularies.
 */
// MIRROR — the AUTHORED order is `GUIDELINE_SCOPE_ORDER` in
// `@synap-core/types/guidelines`; this runtime copy is pinned identical (order
// AND membership) by `guideline-vocabulary-parity.test.ts`. Change it there first.
const SCOPE_ORDER = [
  "default",
  "workKind",
  "sourceKind",
  "entityKind",
  "channelType",
  "bridge",
  "channel",
  "shape",
] as const satisfies ReadonlyArray<ConfigScopeKind>;

/**
 * COMPILE-TIME COVERAGE FLOOR. A scope kind added to the enum but missing from
 * `SCOPE_ORDER` makes this type `never` and the build stops — rather than
 * silently resolving to rank `undefined` and sorting as `NaN`.
 */
type _AllScopeKindsRanked =
  Exclude<ConfigScopeKind, (typeof SCOPE_ORDER)[number]> extends never
    ? true
    : never;
const _allScopeKindsRanked: _AllScopeKindsRanked = true;
void _allScopeKindsRanked;

/**
 * Specificity rank per scope kind (general → specific). A specific guideline is
 * ordered LAST so it reinforces/overrides a general one when concatenated.
 * DERIVED from `SCOPE_ORDER` — never written out by hand.
 */
export const SCOPE_SPECIFICITY = Object.fromEntries(
  SCOPE_ORDER.map((kind, index) => [kind, index])
) as Record<ConfigScopeKind, number>;

export interface ResolveGuidelinesInput {
  /** Injected Drizzle handle (the caller's `db`). */
  db: DbHandle;
  /**
   * The acting user — required for the OWNER FLOOR on pod-wide (NULL-workspace)
   * rows, exactly like the automation matcher's pod-wide branch
   * (`isNull(workspaceId) AND createdBy = userId`) and NOT part of the governance
   * resolver only because governance pod rules are intentionally global. A
   * pod-wide guideline is owner-implicit config, so it applies only to its owner.
   */
  userId: string;
  /** The capability/bridge being interpreted through, if any. */
  capabilityId?: string | null;
  channelId?: string | null;
  channelType?: string | null;
  bridgeId?: string | null;
  /**
   * The KIND OF WORK this resolution is for — a `BLOCKED_REASONS` token (see
   * `SCOPE_ORDER`). Absent/null ⇒ NO `workKind` row can match, which is what
   * keeps every existing caller (message.interpret, `resolveOriginTrust`) on
   * exactly the behaviour it had before this rung existed: none of them passes
   * it.
   */
  workKind?: string | null;
  /**
   * The kind of INPUT being structured (`text | url | image | file | audio` or
   * `import:<source>`). Absent ⇒ no `sourceKind` row can match — the same
   * inert-unless-asked contract as `workKind`.
   */
  sourceKind?: string | null;
  /**
   * The entity kinds (profile slugs) IN PLAY for this structuring pass — the
   * kinds the extractor may produce, plus an anchor's kind. A structure pass
   * runs BEFORE its output kinds are known, so an `entityKind` guideline
   * matches when its kind is available to the extractor, and the assembler
   * frames its text with the kind so the model applies it only to that kind.
   * Absent/empty ⇒ no `entityKind` row can match.
   */
  entityKinds?: readonly string[] | null;
  /** null/undefined = pod lens only (no workspace-scoped rows match). */
  workspaceId?: string | null;
  /** The normalized message — required for `shape`-scoped rows to match. */
  envelope?: MessageEnvelope;
}

/** One resolved guideline, in application order (general → specific). */
export interface ResolvedGuideline {
  id: string;
  /** The row's version (0258). A run manifest records `{id, version}`. */
  version: number;
  scopeKind: ConfigScopeKind;
  /** The rung's ref — e.g. the profile slug of an `entityKind` row. */
  scopeRef: string | null;
  specificity: number;
  text: string;
  posture?: "auto" | "propose";
}

/**
 * Resolve the guideline texts applicable to a message context, ordered
 * most-general → most-specific.
 *
 * SQL FLOOR (mirrors governance's pod-OR-workspace predicate): only rows with
 * `key='guideline'`, not revoked, in the caller's lens —
 *   (workspace_id IS NULL AND created_by = userId)  -- pod-wide, owner-floored
 *   OR workspace_id = :workspaceId                  -- this workspace
 * intersected with the capability floor —
 *   (capability_id IS NULL) OR capability_id = :capabilityId.
 *
 * IN-MEMORY SCOPE MATCH (the additive-specificity ladder): each surviving row is
 * kept only if its `scopeKind` matches the context (default always; workKind /
 * channelType / bridge / channel match their ref; shape matches when the envelope
 * satisfies the row's `shape` via the SHARED `matchMessageShape`). Kept rows are
 * sorted by specificity ascending, tie-broken by `createdAt` ascending
 * (deterministic).
 */
export async function resolveGuidelines(
  input: ResolveGuidelinesInput
): Promise<ResolvedGuideline[]> {
  // channelId / channelType / bridgeId / workKind are read off `input` by
  // `scopeMatches`.
  const { db, userId, capabilityId, workspaceId, envelope } = input;

  const workspaceFloor = or(
    and(
      isNull(configSettings.workspaceId),
      eq(configSettings.createdBy, userId)
    ),
    workspaceId ? eq(configSettings.workspaceId, workspaceId) : sql`false` // no workspace lens → only pod-wide (owner-floored) rows match
  );

  const capabilityFloor = or(
    isNull(configSettings.capabilityId),
    capabilityId ? eq(configSettings.capabilityId, capabilityId) : sql`false`
  );

  const rows = (await db
    .select({
      id: configSettings.id,
      scopeKind: configSettings.scopeKind,
      scopeRef: configSettings.scopeRef,
      value: configSettings.value,
      shape: configSettings.shape,
      version: configSettings.version,
      createdAt: configSettings.createdAt,
    })
    .from(configSettings)
    .where(
      and(
        eq(configSettings.key, GUIDELINE_KEY),
        isNull(configSettings.revokedAt),
        workspaceFloor,
        capabilityFloor
      )
    )) as Array<{
    id: string;
    scopeKind: ConfigScopeKind;
    scopeRef: string | null;
    value: GuidelineValue | Record<string, unknown>;
    shape: MessageShapePredicate | null;
    version: number | null;
    createdAt: Date;
  }>;

  const matched: Array<ResolvedGuideline & { createdAt: Date }> = [];
  for (const row of rows) {
    if (
      !scopeMatches(row.scopeKind, row.scopeRef, row.shape, input, envelope)
    ) {
      continue;
    }
    const value = row.value as GuidelineValue;
    const text = typeof value?.text === "string" ? value.text.trim() : "";
    if (!text) continue; // a guideline with no text contributes nothing
    matched.push({
      id: row.id,
      version: row.version ?? 1,
      scopeKind: row.scopeKind,
      scopeRef: row.scopeRef,
      specificity: SCOPE_SPECIFICITY[row.scopeKind],
      text,
      posture: value.posture,
      createdAt: row.createdAt,
    });
  }

  matched.sort(
    (a, b) =>
      a.specificity - b.specificity ||
      a.createdAt.getTime() - b.createdAt.getTime()
  );

  return matched.map(({ createdAt: _createdAt, ...g }) => g);
}

/**
 * The most-specific `posture` set by any applicable guideline, or `undefined`.
 *
 * ACTIVATES the (until-now dormant) `GuidelineValue.posture` field for the
 * origin-trust gate (governance rung 2.55). `resolveGuidelines` already returns
 * rows ordered general → specific, so the LAST row that carries a `posture` is
 * the most specific and wins — an operator setting `posture:"auto"` on a
 * specific trusted bridge/channel thereby RESTORES auto for it (overriding the
 * default untrusted classification of an external origin), while
 * `posture:"propose"` tightens an otherwise-trusted channel back to review.
 *
 * Pure — reads only the already-resolved guideline list; no I/O.
 */
export function resolveMostSpecificPosture(
  guidelines: ResolvedGuideline[]
): "auto" | "propose" | undefined {
  for (let i = guidelines.length - 1; i >= 0; i--) {
    const posture = guidelines[i]!.posture;
    if (posture) return posture;
  }
  return undefined;
}

/** Does a row's scope match the message context? */
function scopeMatches(
  scopeKind: ConfigScopeKind,
  scopeRef: string | null,
  shape: MessageShapePredicate | null,
  ctx: Pick<
    ResolveGuidelinesInput,
    | "channelId"
    | "channelType"
    | "bridgeId"
    | "workKind"
    | "sourceKind"
    | "entityKinds"
  >,
  envelope: MessageEnvelope | undefined
): boolean {
  switch (scopeKind) {
    case "default":
      return true;
    case "workKind":
      // Absent context ⇒ never matches: a caller that knows nothing about the
      // kind of work must resolve exactly as it did before this rung existed.
      return !!ctx.workKind && scopeRef === ctx.workKind;
    case "sourceKind":
      // Same inert-unless-asked contract as workKind.
      return !!ctx.sourceKind && scopeRef === ctx.sourceKind;
    case "entityKind":
      return !!scopeRef && !!ctx.entityKinds?.includes(scopeRef);
    case "channelType":
      return !!ctx.channelType && scopeRef === ctx.channelType;
    case "bridge":
      return !!ctx.bridgeId && scopeRef === ctx.bridgeId;
    case "channel":
      return !!ctx.channelId && scopeRef === ctx.channelId;
    case "shape":
      return !!shape && matchMessageShape(shape, envelope);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The ONE write/read door (mirrors the governance-rules CRUD, injected db)
// ---------------------------------------------------------------------------

export interface CreateGuidelineInput {
  db: DbHandle;
  text: string;
  posture?: "auto" | "propose";
  scopeKind: ConfigScopeKind;
  scopeRef?: string | null;
  shape?: MessageShapePredicate | null;
  capabilityId?: string | null;
  /** NULL = pod-wide (owner-floored on read). */
  workspaceId?: string | null;
  source?: string;
  createdBy: string;
}

/**
 * Create one guideline (`config_settings` row, key='guideline'). The single
 * write door — access floors are the caller's (tRPC router) concern, exactly as
 * the governance-rules router gates before `db.insert`.
 */
export async function createGuideline(
  input: CreateGuidelineInput
): Promise<ConfigSetting> {
  const value: GuidelineValue = {
    text: input.text,
    ...(input.posture ? { posture: input.posture } : {}),
  };
  const [row] = await input.db
    .insert(configSettings)
    .values({
      key: GUIDELINE_KEY,
      value,
      scopeKind: input.scopeKind,
      scopeRef: input.scopeKind === "shape" ? null : (input.scopeRef ?? null),
      shape: input.scopeKind === "shape" ? (input.shape ?? null) : null,
      capabilityId: input.capabilityId ?? null,
      workspaceId: input.workspaceId ?? null,
      source: input.source ?? "user",
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

export interface ListGuidelinesInput {
  db: DbHandle;
  userId: string;
  /** null/undefined = pod lens only. */
  workspaceId?: string | null;
}

/**
 * List active guidelines visible in the caller's lens: pod-wide rows the caller
 * OWNS (owner-floored) plus this workspace's rows. Newest first. Mirrors the
 * governance-rules `list` predicate (pod ∪ workspace), with the pod-wide owner
 * floor the guideline store applies.
 */
export async function listGuidelines(
  input: ListGuidelinesInput
): Promise<ConfigSetting[]> {
  const { db, userId, workspaceId } = input;
  const scopePredicate = or(
    and(
      isNull(configSettings.workspaceId),
      eq(configSettings.createdBy, userId)
    ),
    workspaceId ? eq(configSettings.workspaceId, workspaceId) : sql`false`
  );
  return db.query.configSettings.findMany({
    where: and(
      eq(configSettings.key, GUIDELINE_KEY),
      isNull(configSettings.revokedAt),
      scopePredicate
    ),
    orderBy: [desc(configSettings.createdAt)],
  });
}

/** Soft-revoke a guideline (sets revokedAt). Returns the row, or undefined if absent. */
export async function revokeGuideline(input: {
  db: DbHandle;
  id: string;
}): Promise<ConfigSetting | undefined> {
  const [row] = await input.db
    .update(configSettings)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(configSettings.id, input.id), isNull(configSettings.revokedAt))
    )
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Versions (0258): an edit is a SUPERSEDE, never an in-place update
// ---------------------------------------------------------------------------

/** Thrown when the row to supersede is absent, not a guideline, or no longer current. */
export class GuidelineSupersedeConflictError extends Error {
  constructor(
    readonly reason: "not_found" | "not_current",
    readonly guidelineId: string
  ) {
    super(
      reason === "not_found"
        ? `Guideline ${guidelineId} not found`
        : `Guideline ${guidelineId} is no longer the current version — reload and edit the latest`
    );
    this.name = "GuidelineSupersedeConflictError";
  }
}

export interface SupersedeGuidelineInput {
  db: DbHandle;
  /** The CURRENT version being edited. */
  id: string;
  text: string;
  /** Omitted ⇒ the previous version's posture carries over. */
  posture?: "auto" | "propose";
  /** Provenance of the new version ('user' | 'proposal:<id>' | …). */
  source?: string;
  createdBy: string;
}

/**
 * Edit a guideline by SUPERSEDING it: in ONE transaction, revoke the current
 * row (only if still current) and insert version + 1 carrying the same scope
 * (capability, rung, ref, shape, workspace) with `supersedesId` = the old id.
 *
 * Scope is deliberately NOT editable here: a guideline moved to a different
 * rung is a different guideline, and its history would otherwise claim a
 * lineage across two situations. Access floors are the caller's concern (the
 * router gates on the LOADED row, like `revoke`).
 *
 * Concurrency: the revoke's `revoked_at IS NULL` guard lets only one of two
 * racing edits proceed; the partial UNIQUE index on `supersedes_id` backs it at
 * the database level.
 */
export async function supersedeGuideline(
  input: SupersedeGuidelineInput
): Promise<{ previous: ConfigSetting; guideline: ConfigSetting }> {
  return input.db.transaction(async (tx) => {
    const [previous] = await tx
      .update(configSettings)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(configSettings.id, input.id),
          eq(configSettings.key, GUIDELINE_KEY),
          isNull(configSettings.revokedAt)
        )
      )
      .returning();
    if (!previous) {
      const existing = await tx.query.configSettings.findFirst({
        where: and(
          eq(configSettings.id, input.id),
          eq(configSettings.key, GUIDELINE_KEY)
        ),
        columns: { id: true },
      });
      throw new GuidelineSupersedeConflictError(
        existing ? "not_current" : "not_found",
        input.id
      );
    }
    const prevValue = previous.value as GuidelineValue;
    const posture = input.posture ?? prevValue?.posture;
    const value: GuidelineValue = {
      text: input.text,
      ...(posture ? { posture } : {}),
    };
    const [guideline] = await tx
      .insert(configSettings)
      .values({
        key: GUIDELINE_KEY,
        value,
        scopeKind: previous.scopeKind,
        scopeRef: previous.scopeRef,
        shape: previous.shape,
        capabilityId: previous.capabilityId,
        workspaceId: previous.workspaceId,
        source: input.source ?? "user",
        createdBy: input.createdBy,
        version: (previous.version ?? 1) + 1,
        supersedesId: previous.id,
      })
      .returning();
    return { previous, guideline };
  });
}

/** The longest chain history will walk — a guard against a corrupt cycle. */
const MAX_HISTORY_DEPTH = 500;

/**
 * The full version history of the guideline `id` belongs to, NEWEST FIRST —
 * walking back through `supersedesId` to version 1 and forward to the current
 * (or last revoked) head. Includes revoked versions: that IS the history.
 * Returns `[]` when `id` is not a guideline. Access is the caller's concern.
 */
export async function listGuidelineHistory(input: {
  db: DbHandle;
  id: string;
}): Promise<ConfigSetting[]> {
  const { db } = input;
  const start = await db.query.configSettings.findFirst({
    where: and(
      eq(configSettings.id, input.id),
      eq(configSettings.key, GUIDELINE_KEY)
    ),
  });
  if (!start) return [];

  const chain: ConfigSetting[] = [start];
  const seen = new Set([start.id]);
  let back = start;
  while (back.supersedesId && chain.length < MAX_HISTORY_DEPTH) {
    const prev = await db.query.configSettings.findFirst({
      where: eq(configSettings.id, back.supersedesId),
    });
    if (!prev || seen.has(prev.id)) break;
    seen.add(prev.id);
    chain.push(prev);
    back = prev;
  }
  let forward = start;
  while (chain.length < MAX_HISTORY_DEPTH) {
    const next = await db.query.configSettings.findFirst({
      where: eq(configSettings.supersedesId, forward.id),
    });
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    chain.push(next);
    forward = next;
  }
  return chain.sort((a, b) => (b.version ?? 1) - (a.version ?? 1));
}

// ---------------------------------------------------------------------------
// Corrections → guideline versions (intake W5). ONE copy of the text cap, the
// current-row lookup and the inferred-guideline proposal payload, shared by the
// jobs scanner (files the proposal) and the api approve path (applies it).
// ---------------------------------------------------------------------------

/**
 * THE cap on one guideline's text. The write door's zod schemas, both
 * correction paths and the structure-instructions budget
 * (`STRUCTURE_INSTRUCTIONS_BUDGET`, which a single guideline must fit whole)
 * all read this one number.
 */
export const GUIDELINE_TEXT_MAX = 2000;

/** Filed by the structure-guideline scanner; applied on approval. */
export const STRUCTURE_GUIDELINE_PROPOSAL_TYPE =
  "governance.structure_guideline";

/** The data-type rungs a correction can target, plus the lens-only default. */
export type StructureGuidelineScopeKind =
  "default" | "sourceKind" | "entityKind";

/** The `governance.structure_guideline` payload — the ONE declaration. */
export interface StructureGuidelineProposalData {
  /** The human whose corrections these are — the guideline's owner. */
  userId: string;
  /**
   * The same human under the ownership key the review ladder reads
   * (`data.sourceId`, as `createProposal` writes it) — so the subject may
   * approve their own pod-wide proposal at the approve door.
   */
  sourceId: string;
  /** Stable cluster identity (user × rung × ref) — the dedup key. */
  clusterKey: string;
  scopeKind: StructureGuidelineScopeKind;
  scopeRef: string | null;
  /** NULL = pod-wide (owner-floored on read). */
  workspaceId: string | null;
  /** The FULL proposed version text (reviewer-editable). */
  text: string;
  /**
   * ONLY what the evidence adds, kept apart from `text` so a rebase onto a
   * newer version appends it once and never re-appends old guideline text.
   */
  addition: string;
  /** Approval SUPERSEDES this version; null = no guideline existed. */
  supersedesGuidelineId: string | null;
  /** The superseded version's text, so the reviewer sees the diff. */
  currentText: string | null;
  evidence: {
    corrections: number;
    proposals: number;
    windowDays: number;
    reasonHistogram: Record<string, number>;
    exampleReasons: string[];
    sampleProposalIds: string[];
  };
  /** Set when an approval found the guideline moved and re-drafted instead. */
  rebase?: {
    reason: string;
    at: string;
    previousSupersedesGuidelineId: string | null;
  };
}

export interface CurrentGuideline {
  id: string;
  text: string;
  createdAt: Date;
}

/**
 * The CURRENT (unrevoked, capability-free) guideline at one rung in one lens:
 * a workspace's row, or the user's own pod-wide row (owner floor). Newest first
 * when several exist. Returns null when none — the caller creates version 1.
 */
export async function findCurrentGuideline(input: {
  db: DbHandle;
  userId: string;
  scopeKind: ConfigScopeKind;
  scopeRef?: string | null;
  workspaceId?: string | null;
}): Promise<CurrentGuideline | null> {
  const [row] = await input.db
    .select({
      id: configSettings.id,
      value: configSettings.value,
      createdAt: configSettings.createdAt,
    })
    .from(configSettings)
    .where(
      and(
        eq(configSettings.key, GUIDELINE_KEY),
        isNull(configSettings.revokedAt),
        isNull(configSettings.capabilityId),
        eq(configSettings.scopeKind, input.scopeKind),
        input.scopeRef
          ? eq(configSettings.scopeRef, input.scopeRef)
          : isNull(configSettings.scopeRef),
        input.workspaceId
          ? eq(configSettings.workspaceId, input.workspaceId)
          : and(
              isNull(configSettings.workspaceId),
              eq(configSettings.createdBy, input.userId)
            )
      )
    )
    .orderBy(desc(configSettings.createdAt))
    .limit(1);
  if (!row) return null;
  const text = (row.value as { text?: unknown } | null)?.text;
  return {
    id: row.id,
    text: typeof text === "string" ? text : "",
    createdAt: row.createdAt,
  };
}
