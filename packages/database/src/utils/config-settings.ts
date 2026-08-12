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
 * layers are the scope granularities (default < channelType < bridge < channel <
 * shape); it returns the applicable guideline texts ordered most-general →
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
 * Specificity rank per scope kind (general → specific). A specific guideline is
 * ordered LAST so it reinforces/overrides a general one when concatenated.
 */
const SCOPE_SPECIFICITY: Record<ConfigScopeKind, number> = {
  default: 0,
  channelType: 1,
  bridge: 2,
  channel: 3,
  shape: 4,
};

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
  /** null/undefined = pod lens only (no workspace-scoped rows match). */
  workspaceId?: string | null;
  /** The normalized message — required for `shape`-scoped rows to match. */
  envelope?: MessageEnvelope;
}

/** One resolved guideline, in application order (general → specific). */
export interface ResolvedGuideline {
  id: string;
  scopeKind: ConfigScopeKind;
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
 * kept only if its `scopeKind` matches the context (default always; channelType /
 * bridge / channel match their ref; shape matches when the envelope satisfies the
 * row's `shape` via the SHARED `matchMessageShape`). Kept rows are sorted by
 * specificity ascending, tie-broken by `createdAt` ascending (deterministic).
 */
export async function resolveGuidelines(
  input: ResolveGuidelinesInput
): Promise<ResolvedGuideline[]> {
  // channelId / channelType / bridgeId are read off `input` by `scopeMatches`.
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
      scopeKind: row.scopeKind,
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

/** Does a row's scope match the message context? */
function scopeMatches(
  scopeKind: ConfigScopeKind,
  scopeRef: string | null,
  shape: MessageShapePredicate | null,
  ctx: Pick<ResolveGuidelinesInput, "channelId" | "channelType" | "bridgeId">,
  envelope: MessageEnvelope | undefined
): boolean {
  switch (scopeKind) {
    case "default":
      return true;
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
