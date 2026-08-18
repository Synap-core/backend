/**
 * WorkspaceResolutionService — THE one door for "which workspace does this land
 * in?" (invariant I1). Beside IdentityResolutionService because @synap/jobs (the
 * proposal materializer) can't import @synap/api, so the resolver must live in
 * @synap/database where every producer — api handlers, jobs workers — reaches
 * the SAME logic.
 *
 * Placement is DERIVED, never free-picked. `resolveWorkspacePlacement` walks a
 * fixed 6-rung ladder and returns the first rung that produces a definitive
 * workspace, with a code-generated, auditable reason:
 *
 *   1. Explicit    — caller passed a workspace (or a deliberate pod-wide null),
 *                    or the K1 `global` flag. Wins over ontology/context/AI.
 *   2. Ontology    — the kind/facet slug is a role enabled in exactly ONE
 *                    workspace the caller belongs to (inverse of the slug→scope
 *                    query). >1 → those become candidates for a later tie-break.
 *   3. Context     — a bound channel's workspace, else the active focus session.
 *   4. Relational  — the shared lens of the entities this one links to.
 *   5. AI tie-break — PROPOSES, never ACTS (ratified). Consulted ONLY over the
 *                    reduced candidate set (or, absent candidates, the member
 *                    set). Rungs 1–4 are deterministic and place data outright;
 *                    rung 5 is a guess, so it always returns `ask: true` with
 *                    the data left in the ambient workspace and the suggestion
 *                    in `candidates[0]` for the caller to confirm. It can never
 *                    move data on its own.
 *   6. Default     — the entity-scope K1 precedence (pod → null, workspace →
 *                    ambient). Absorbs `resolveEntityWorkspacePlacement` so there
 *                    is ONE implementation of that precedence.
 *
 * SECURITY (I2): every candidate/definitive workspace is intersected with the
 * caller's `workspace_members` rows (+ non-archived + routable type) BEFORE it
 * can appear in a result or a reason string — the raw slug→workspaces query has
 * no membership filter, so naive use would leak workspace existence.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  channels,
  entities,
  focusSessions,
  links,
  profiles,
  profileWorkspaceAccess,
  workspaces,
  workspaceMembers,
} from "../schema/index.js";
import type * as schema from "../schema/index.js";
import {
  resolveCaptureRouting,
  BYOA_DEFAULT_ROUTE_CONFIDENCE,
  type WorkspaceRoutingMode,
} from "./capture-routing.js";
import { ProfileResolutionService } from "./profile-resolution-service.js";

type Db = PostgresJsDatabase<typeof schema>;

// ── The moved K1 primitives (one implementation, re-exported by @synap/api) ──

/**
 * Which workspace TYPES may be offered as AUTO-routing candidates for captured
 * user data. Excludes `operational` (system/admin surfaces) and `agent`
 * (ratified decision D2). Explicit `workspaceId` targeting elsewhere is
 * unaffected. Archival is orthogonal (`archivedAt IS NULL`, enforced below).
 *
 * Type-only. Prefer {@link isDomainHomeWorkspace} when settings/systemSlug are
 * available — admin/settings surfaces may be mis-typed as `personal` in legacy
 * data and are excluded via `surfaceClass` / system slug, not display name.
 *
 * MOVED here from @synap/api in Wave 1 so the door and the api candidate-list
 * builder share ONE definition; `@synap/api`'s `lib/routing-candidates.ts`
 * re-exports it.
 */
export function isRoutableWorkspaceType(
  workspaceType: string | null | undefined
): boolean {
  return workspaceType !== "operational" && workspaceType !== "agent";
}

/**
 * Signals used to decide whether a workspace may be a domain-data home
 * (auto-placement candidate or explicit filing target for kinds/roles).
 * Prefer metadata over display names — never gate on workspace NAME.
 */
export type WorkspaceHomeSignals = {
  workspaceType?: string | null;
  /** Column SSOT for built-in system workspaces (e.g. pod-admin). */
  systemSlug?: string | null;
  /**
   * Partial settings bag — only surfaceClass/systemSlug are read.
   * No index signature: keeps `WorkspaceSettings` (and other concrete settings
   * types) assignable without casts at call sites (tsc structural typing).
   */
  settings?: {
    surfaceClass?: string | null;
    systemSlug?: string | null;
  } | null;
};

/**
 * Error message when a caller tries to file domain entity data into an
 * admin/settings/agent/operational workspace. Shared by create doors + tests.
 */
export const DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE =
  "Cannot file domain data into an admin/settings workspace; omit workspaceId for server placement or pick a domain app.";

/**
 * True when this workspace may be an auto-home / ambient default / explicit
 * filing target for **domain** entity data (CRM, content, personal notes, …).
 *
 * Excludes:
 * - `workspaceType` operational | agent (via {@link isRoutableWorkspaceType})
 * - `settings.surfaceClass` admin | settings (template/operator metadata)
 * - built-in system slug `pod-admin` (column or settings dual-write)
 *
 * Templates that mint admin/settings surfaces MUST set `workspaceType:
 * "operational"` and/or `settings.surfaceClass: "admin"|"settings"`. Do not
 * rely on the display name — product code never hardcodes workspace names.
 */
export function isDomainHomeWorkspace(ws: WorkspaceHomeSignals): boolean {
  if (!isRoutableWorkspaceType(ws.workspaceType)) return false;
  const surfaceClass = ws.settings?.surfaceClass ?? null;
  if (surfaceClass === "admin" || surfaceClass === "settings") return false;
  const slug = ws.systemSlug ?? ws.settings?.systemSlug ?? null;
  // systemSlug is the SSOT identifier for built-in system workspaces — not a
  // display name. pod-admin is the only admin system surface today.
  if (slug === "pod-admin") return false;
  return true;
}

/**
 * Entity workspace-placement precedence (rung 6) — the ONE resolver for "where
 * does this entity land" on the create path. Pure (no DB/IO) so it runs
 * identically at proposal-creation time (persist the result) and on the
 * auto-approved inline write (invariant I3).
 *
 * Precedence: `global` → null · explicit `targetWorkspaceId` → that workspace ·
 * `workspaceScoped` → ambient (import isolation) · else profile pod-default
 * (entityScope "pod" → null) else ambient.
 *
 * MOVED here from @synap/api in Wave 1 (absorbed into the door); the api helper
 * re-exports it, so the CI tripwire's "one K1 implementation" holds.
 */
/**
 * Canonical default when a kind's entityScope is missing/null.
 * Matches schema column default (migration 0220) + ProfileRepository write door:
 * omitted kind scope = pod. Explicit `"workspace"` remains for process kinds.
 */
export const DEFAULT_ENTITY_SCOPE: "pod" | "workspace" = "pod";

/**
 * Normalize a stored/resolved entityScope to the two legal values.
 * Only the explicit string `"workspace"` pins; everything else (pod, null,
 * undefined, garbage) is pod — identity by default, process pin by declaration.
 */
export function normalizeEntityScope(
  scope: string | null | undefined
): "pod" | "workspace" {
  return scope === "workspace" ? "workspace" : DEFAULT_ENTITY_SCOPE;
}

/**
 * Create-door pin flags for one kind given an optional process home.
 * THE shared rule for capture execute, capture thought, graph op stamps, and
 * any other writer that must not turn ambient lens into identity prison.
 *
 * - Explicit `targetWorkspaceId` → pin (workspaceScoped)
 * - Pod-scope kind → no pin (home NULL; facets carry role-as-lens)
 * - Workspace-scope kind + routed home → pin to that home
 * - Workspace-scope with no home → no pin (caller ambient / rung-6)
 */
export function resolveKindWritePin(input: {
  entityScope?: string | null;
  /** Per-op or caller explicit pin (wins). */
  targetWorkspaceId?: string | null;
  /** Graph majority / ambient process home — never applied to pod kinds. */
  routedWorkspaceId?: string | null;
}): {
  targetWorkspaceId: string | undefined;
  workspaceScoped: boolean;
} {
  if (input.targetWorkspaceId) {
    return {
      targetWorkspaceId: input.targetWorkspaceId,
      workspaceScoped: true,
    };
  }
  if (normalizeEntityScope(input.entityScope) === "pod") {
    return { targetWorkspaceId: undefined, workspaceScoped: false };
  }
  if (input.routedWorkspaceId) {
    return {
      targetWorkspaceId: input.routedWorkspaceId,
      workspaceScoped: true,
    };
  }
  return { targetWorkspaceId: undefined, workspaceScoped: false };
}

/**
 * Config-first resolver for the guild→workspace hint (item 4 of the pod-wide
 * bridge model). Reads a `guildWorkspaceMap` (`{ [guildId]: workspaceId }`) off
 * a bridge tool/capability's metadata bag and looks up the given guild id.
 *
 * Pure — no DB, no I/O — so the inbound path can resolve the operator's declared
 * mapping and pass the result as `guildHint` to `resolveWorkspacePlacement`
 * (mirrors how `aiHint` is pre-resolved by the caller). Returns undefined when
 * there is no guild id, no map, or no mapping for that guild, so placement
 * cleanly falls through to ontology role-routing.
 *
 * Membership is NOT checked here — that is the resolver's I2 floor (a mapping to
 * a workspace the caller can't see is ignored downstream).
 */
export function resolveGuildWorkspaceHint(
  metadata: unknown,
  guildId: string | null | undefined
): { workspaceId: string; guildId: string } | undefined {
  if (!guildId) return undefined;
  if (!metadata || typeof metadata !== "object") return undefined;
  const map = (metadata as { guildWorkspaceMap?: unknown }).guildWorkspaceMap;
  if (!map || typeof map !== "object") return undefined;
  const workspaceId = (map as Record<string, unknown>)[guildId];
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return undefined;
  }
  return { workspaceId, guildId };
}

export function resolveEntityWorkspacePlacement(input: {
  global: boolean;
  targetWorkspaceId?: string | null;
  workspaceScoped: boolean;
  /**
   * The profile's `entityScope` ("pod" | "workspace").
   * Defaults to **pod** (schema 0220 + ProfileRepository). Explicit
   * `"workspace"` required for process kinds (deal, pipeline, …).
   */
  profileEntityScope?: string | null;
  /** The governance/ambient workspace (targetWorkspaceId ?? ctx.workspaceId ?? null). */
  ambientWorkspaceId: string | null;
}): string | null {
  if (input.global) return null;
  if (input.targetWorkspaceId) return input.targetWorkspaceId;
  if (input.workspaceScoped) return input.ambientWorkspaceId;
  const scope = normalizeEntityScope(input.profileEntityScope);
  return scope === "pod" ? null : input.ambientWorkspaceId;
}

/**
 * Read-back of the RESOLVED workspace placement a create/attach door already
 * computed and persisted into a proposal's `data` (invariant I3:
 * resolve-early-and-persist). The materializer AND interactive approve must land
 * a proposal-gated write EXACTLY where an auto-approved one would — so they
 * read the persisted value verbatim rather than re-deriving from the ambient
 * governance workspace (the "four-door" bug: same capture lands pod-wide if
 * auto-approved, workspace-pinned if reviewed).
 *
 * Backward compat: proposals created before `resolvedWorkspaceId` existed lack
 * the key → fall back to the historical derivation. A present-but-null value is
 * meaningful (a pod-scope kind resolved to NULL) and MUST win over the fallback,
 * so helpers branch on KEY PRESENCE, never on `??`.
 *
 * Lives here (not jobs-only) so `@synap/api` approve executors and `@synap/jobs`
 * materializer share ONE implementation.
 */

/** Entity-create read-back. Legacy fallback: `data.global ? null : ambient`. */
export function resolveMaterializedEntityWorkspaceId(
  data: Record<string, unknown>,
  ambientWorkspaceId: string | null | undefined
): string | null {
  if ("resolvedWorkspaceId" in data) {
    return (data.resolvedWorkspaceId as string | null) ?? null;
  }
  return data.global ? null : (ambientWorkspaceId ?? null);
}

/**
 * Facet-attach read-back. Legacy fallback: `data.workspaceId ?? ambient` (the
 * facet lens the door persisted, else the ambient governance workspace).
 */
export function resolveMaterializedFacetWorkspaceId(
  data: Record<string, unknown>,
  ambientWorkspaceId: string | null | undefined
): string | null {
  if ("resolvedWorkspaceId" in data) {
    return (data.resolvedWorkspaceId as string | null) ?? null;
  }
  return (data.workspaceId as string | undefined) ?? ambientWorkspaceId ?? null;
}

/**
 * Relation-create read-back (D4). The door resolves the edge's INHERITED lens
 * (both endpoints pod-wide → NULL; else the workspace-scoped endpoint's lens)
 * and persists it as `resolvedWorkspaceId`. Legacy fallback: `data.workspaceId
 * ?? ambient` — a present-null there is NOT meaningful for old proposals (the
 * pre-D4 path stamped the ambient), so `??` is correct for the fallback branch.
 */
export function resolveMaterializedRelationWorkspaceId(
  data: Record<string, unknown>,
  ambientWorkspaceId: string | null | undefined
): string | null {
  if ("resolvedWorkspaceId" in data) {
    return (data.resolvedWorkspaceId as string | null) ?? null;
  }
  return (data.workspaceId as string | undefined) ?? ambientWorkspaceId ?? null;
}

/**
 * Ingestion-door placement (decision D1) — the ONE glue every bulk/feed/upload
 * importer uses instead of hard-pinning the source workspace. An imported
 * person/company is a pod-wide thing that happens to have been *seen* in a
 * workspace: the source workspace is a CONTEXT signal, never a hard pin. This
 * fetches the profile's `entityScope` and runs the door so a pod-scope kind
 * lands pod-wide (NULL) while a genuinely workspace-scoped role stays in the
 * workspace its ontology enables (rung 2) or, failing that, the source lens.
 *
 * `EntityRepository.create` stores whatever `workspaceId` it is given verbatim
 * (it no longer re-derives scope), so the importer MUST resolve here first.
 */
export async function resolveImportEntityPlacement(
  db: Db,
  input: {
    userId: string;
    profileSlug: string;
    /** The import/feed's workspace — a CONTEXT signal (D1), not a hard pin. */
    sourceWorkspaceId: string | null;
  }
): Promise<string | null> {
  const entityScope = await new ProfileResolutionService(db).getEntityScope(
    input.profileSlug,
    input.sourceWorkspaceId
  );
  const placement = await resolveWorkspacePlacement(db, {
    userId: input.userId,
    kindSlug: input.profileSlug,
    entityScope,
    ambientWorkspaceId: input.sourceWorkspaceId,
  });
  return placement.workspaceId;
}

/**
 * Graph-batch placement acceptance policy (shared by capture.graph + import
 * analyze when the caller supplied no explicit lens).
 *
 * A composite graph may adopt a workspace ONLY when the placement door returns
 * a deterministic hit: rung ≤4, no multi-candidate ambiguity (`candidates`
 * empty — a definitive single winner leaves that list empty), and a concrete
 * `workspaceId`. Ambiguous (>1 candidate) or no ontology signal (rung 6) →
 * stay pod-wide (`null`). Never invent `membership[0]`.
 *
 * Pure so callers (and unit tests) can apply the same accept/abstain rule the
 * async helper uses without re-deriving it.
 */
export function acceptDeterministicGraphWorkspace(
  placement: Pick<WorkspacePlacement, "workspaceId" | "rung" | "candidates">
): string | null {
  if (
    placement.candidates.length === 0 &&
    placement.rung <= 4 &&
    placement.workspaceId
  ) {
    return placement.workspaceId;
  }
  return null;
}

/**
 * When a composite graph has no explicit workspace/lens, derive one from its
 * ontology slugs via the ONE placement door (`resolveWorkspacePlacement`).
 *
 * Call only when the caller's `workspaceId` is already `null` — an explicit
 * lens always wins and must not be overridden here. Empty `routingSlugs` →
 * null immediately. Errors propagate so callers keep their own log context.
 *
 * Shared by `submitCaptureGraph` and `ImportOrchestrator.resolveGraphPlacement`.
 */
export async function resolveGraphWorkspaceFromSlugs(
  db: Db,
  input: {
    userId: string;
    /**
     * Deduped profile + facet slugs collected from the graph. First entry is
     * the kindSlug; the rest are facetSlugs (order is stable for tests, not
     * otherwise significant — the door unions them for ontology lookup).
     */
    routingSlugs: string[];
    /** Optional focus-session signal for rung 3. */
    sessionId?: string | null;
  }
): Promise<string | null> {
  if (input.routingSlugs.length === 0) return null;
  const placement = await resolveWorkspacePlacement(db, {
    userId: input.userId,
    kindSlug: input.routingSlugs[0],
    facetSlugs: input.routingSlugs.slice(1),
    ambientWorkspaceId: null,
    ...(input.sessionId ? { context: { sessionId: input.sessionId } } : {}),
  });
  return acceptDeterministicGraphWorkspace(placement);
}

// ── The door ────────────────────────────────────────────────────────────────

export type ResolutionRung = 1 | 2 | 3 | 4 | 5 | 6;

export interface WorkspaceCandidate {
  id: string;
  name: string;
}

export interface WorkspacePlacement {
  /** The resolved lens — `null` means pod-wide (visible in every workspace). */
  workspaceId: string | null;
  /** Which rung decided (for telemetry + explainability, invariant I6). */
  rung: ResolutionRung;
  /** Code-generated, auditable reason. Never references a non-member workspace. */
  reason: string;
  /** 1.0 for deterministic rungs (1–4, 6); the hint's confidence for rung 5. */
  confidence: number;
  /**
   * The reduced set surfaced when a rung couldn't pick a single winner.
   * When `ask` is true, `candidates[0]` IS the suggested workspace.
   */
  candidates: WorkspaceCandidate[];
  /**
   * A suggestion the caller must confirm before moving. Set by EVERY rung-5
   * resolution (a rung-5 AI guess proposes, it never acts), regardless of
   * routing mode. `workspaceId` stays on the ambient workspace when this is
   * true, so ignoring it is safe — it means "didn't move", never "didn't write".
   */
  ask: boolean;
}

export interface ResolveWorkspacePlacementInput {
  userId: string;
  /** The entity's kind slug (rung-2 ontology signal). */
  kindSlug?: string;
  /** Role/facet slugs the entity plays (rung-2 ontology signal). */
  facetSlugs?: string[];
  /**
   * A deliberate placement (rung 1). `undefined` = not provided; `null` = the
   * caller explicitly wants pod-wide; a string = that workspace. Wins over
   * ontology/context/AI.
   */
  explicitWorkspaceId?: string | null;
  /** The caller's session/ctx workspace (rung-6 default + rung-5 "stay put"). */
  ambientWorkspaceId?: string | null;
  /**
   * Context signals for rung 3. `projectId` is ORTHOGONAL to workspace — never
   * derive a workspace from a project — so it is deliberately absent here.
   */
  context?: { channelId?: string | null; sessionId?: string | null };
  /** Entities this one links to (rung-4 relational gravity). */
  relatedEntityIds?: string[];
  /**
   * A DECLARED guild→workspace mapping (operator config on the bridge
   * tool/capability, e.g. `guildWorkspaceMap` on the Discord tool metadata).
   * When present it is a HIGH-priority, deterministic signal that OVERRIDES
   * ontology role-routing (rung 2) — a guild that a human has explicitly pinned
   * to a workspace wins over "which lens enables this role". Still floored by I2
   * membership: a mapping to a workspace the caller can't see is ignored (falls
   * through to ontology). Config-first: the CALLER resolves the guildId → this
   * workspace via `resolveGuildWorkspaceHint`, mirroring how `aiHint` is passed
   * in pre-resolved rather than the resolver loading config itself.
   *
   * Ranked BELOW an explicit caller pin (rung 1 proper) — an explicit
   * `explicitWorkspaceId`/`global` still wins over guild config.
   */
  guildHint?: {
    workspaceId: string;
    /** The guild id, for the audit reason string. */
    guildId?: string;
  };
  /** The AI's tie-break suggestion (rung 5). Only consulted over candidates. */
  aiHint?: {
    workspaceId: string;
    confidence?: number | null;
    reason?: string | null;
  };
  /** Rung-5 gate mode. Default "auto". */
  mode?: WorkspaceRoutingMode;
  /** Auto-tuned per-target gate the caller supplies (rung 5). */
  minConfidence?: number;
  // ── Rung-6 (K1) inputs ──
  entityScope?: "pod" | "workspace" | null;
  globalFlag?: boolean;
  workspaceScopedFlag?: boolean;
}

interface MemberWorkspace {
  id: string;
  name: string;
  type: string | null;
}

/**
 * The caller's routable member workspaces (member ∩ non-archived ∩ routable) —
 * the I2 floor every candidate is intersected with. Filtered in JS (not SQL) so
 * the membership/archival/type guards are unit-testable against a mock db.
 *
 * PERF SEAM: one bounded query per resolve. If rung-2 slug lookups ever show up
 * hot, cache this per (user) with explicit invalidation on membership change —
 * do NOT copy the template-seed cache hole (it never invalidates).
 */
async function loadRoutableMemberWorkspaces(
  db: Db,
  userId: string
): Promise<Map<string, MemberWorkspace>> {
  const memberRows = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.userId, userId),
    columns: { workspaceId: true },
  });
  const memberIds = new Set(memberRows.map((r) => r.workspaceId));
  const map = new Map<string, MemberWorkspace>();
  if (memberIds.size === 0) return map;

  const wsRows = await db.query.workspaces.findMany({
    where: inArray(workspaces.id, [...memberIds]),
    columns: {
      id: true,
      name: true,
      workspaceType: true,
      archivedAt: true,
      systemSlug: true,
      settings: true,
    },
  });
  for (const w of wsRows) {
    if (!memberIds.has(w.id)) continue; // I2 floor (redundant under SQL, load-bearing under mock)
    if (w.archivedAt) continue;
    // Domain-home floor: type + surfaceClass + systemSlug (not display name).
    if (
      !isDomainHomeWorkspace({
        workspaceType: w.workspaceType,
        systemSlug: w.systemSlug,
        settings: w.settings as WorkspaceHomeSignals["settings"],
      })
    ) {
      continue;
    }
    map.set(w.id, { id: w.id, name: w.name, type: w.workspaceType });
  }
  return map;
}

/**
 * The looser member set the rung-5 gate uses when there are no reduced
 * candidates — MIRRORS `getUserWorkspaceIds` (@synap/api): members + pod-visible
 * workspaces, no routable/archival filter, so capture's move gate stays exactly
 * equivalent to its pre-door behaviour.
 */
async function loadRoutingMemberIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.userId, userId),
    columns: { workspaceId: true },
  });
  const ids = new Set(rows.map((r) => r.workspaceId));
  const podReadable = await db.query.workspaces.findMany({
    where: sql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`,
    columns: { id: true },
  });
  for (const w of podReadable) ids.add(w.id);
  return [...ids];
}

/**
 * The rung-4 feeds seam — read the materialized workspace-edge graph so a
 * DECLARED provider/feeds-source can tie-break placement.
 *
 * `settings.defaultSources` (stored on a CONSUMER workspace) is backfilled into
 * first-class `workspace --feeds--> workspace` rows in `links` (provider →
 * consumer). This returns the PROVIDER (feeds-source) workspace ids that feed
 * `consumerWorkspaceId` — i.e. every `P` with `P --feeds--> consumer` — so the
 * resolver can prefer the declared source-of-truth workspace among candidates.
 *
 * Kind-scoped: a feeds edge whose declared kind (`metadata.profileSlug`) is set
 * only counts when it matches one of `kindSlugs`; an UNqualified edge (no
 * profileSlug) is domain-wide and always counts. So a workspace that declares an
 * edge for an unrelated kind never influences THIS kind's placement.
 *
 * Edge invariant (see `schema/links.ts`): `feeds` governs LENS PROPAGATION,
 * never data movement — the caller therefore only ever uses this to pick AMONG
 * already-valid candidates, never to relocate data to a brand-new workspace.
 */
async function loadFeedsProviders(
  db: Db,
  consumerWorkspaceId: string,
  kindSlugs: string[]
): Promise<Set<string>> {
  const rows = await db.query.links.findMany({
    where: and(
      eq(links.linkType, "feeds"),
      eq(links.fromType, "workspace"),
      eq(links.toType, "workspace"),
      eq(links.toId, consumerWorkspaceId)
    ),
    columns: { fromId: true, metadata: true },
  });
  const providers = new Set<string>();
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as { profileSlug?: string | null };
    const slug = meta.profileSlug ?? null;
    // A kind-qualified edge only applies to its own kind; unqualified = any kind.
    if (slug && kindSlugs.length > 0 && !kindSlugs.includes(slug)) continue;
    providers.add(r.fromId);
  }
  return providers;
}

function describeSlugs(slugs: string[]): string {
  if (slugs.length === 1) return `role '${slugs[0]}'`;
  return `roles ${slugs.map((s) => `'${s}'`).join(", ")}`;
}

/**
 * Resolve the workspace placement for a piece of data — THE one door (I1).
 *
 * @param db  Schema-typed database handle (the caller's, so it shares the txn).
 */
export async function resolveWorkspacePlacement(
  db: Db,
  input: ResolveWorkspacePlacementInput
): Promise<WorkspacePlacement> {
  const ambient = input.ambientWorkspaceId ?? null;

  // ── Rung 1 — explicit / deliberate placement (wins over ontology & AI) ──
  if (input.globalFlag) {
    return {
      workspaceId: null,
      rung: 1,
      reason: "global flag set → pod-wide (visible in every workspace)",
      confidence: 1,
      candidates: [],
      ask: false,
    };
  }
  if (input.explicitWorkspaceId !== undefined) {
    return {
      workspaceId: input.explicitWorkspaceId,
      rung: 1,
      reason:
        input.explicitWorkspaceId === null
          ? "explicit pod-wide placement (caller passed null)"
          : "explicit workspace supplied by the caller",
      confidence: 1,
      candidates: [],
      ask: false,
    };
  }

  // Memoized I2 floor — only loaded when a signal rung actually needs it (a
  // pure K1 call, e.g. entities.create, never touches the DB).
  let memberMap: Map<string, MemberWorkspace> | null = null;
  const getMemberMap = async () =>
    (memberMap ??= await loadRoutableMemberWorkspaces(db, input.userId));

  // ── Rung 1 (guild override) — a DECLARED guild→workspace mapping pins
  // placement for traffic from that guild, OVERRIDING ontology role-routing.
  // Additive: only consulted when the caller passed a resolved guildHint.
  // Floored by I2 — a mapping to a non-member workspace is ignored (falls
  // through to ontology). Ranked below explicit caller pin / global (rung 1
  // proper, handled above), above rung 2 ontology.
  if (input.guildHint?.workspaceId) {
    const map = await getMemberMap();
    const w = map.get(input.guildHint.workspaceId);
    if (w) {
      return {
        workspaceId: w.id,
        rung: 1,
        reason: input.guildHint.guildId
          ? `guild '${input.guildHint.guildId}' is mapped to workspace '${w.name}' (declared guild→workspace config)`
          : `guild mapped to workspace '${w.name}' (declared guild→workspace config)`,
        confidence: 1,
        candidates: [],
        ask: false,
      };
    }
    // Non-member / unknown mapping → ignore; ontology (rung 2) decides.
  }

  let candidates: WorkspaceCandidate[] = [];

  // ── Rung 2 — ontology-implied (the role is enabled in exactly one lens) ──
  const slugs = [input.kindSlug, ...(input.facetSlugs ?? [])].filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  if (slugs.length > 0) {
    const profileRows = await db.query.profiles.findMany({
      where: and(inArray(profiles.slug, slugs), eq(profiles.isActive, true)),
      columns: { id: true, slug: true, scope: true, workspaceId: true },
    });
    const implied = new Set<string>();
    let hadOntologySignal = false;
    for (const p of profileRows) {
      if (p.scope === "workspace" && p.workspaceId) {
        hadOntologySignal = true;
        implied.add(p.workspaceId);
      } else if (p.scope === "shared") {
        hadOntologySignal = true;
        const grants = await db.query.profileWorkspaceAccess.findMany({
          where: eq(profileWorkspaceAccess.profileId, p.id),
          columns: { workspaceId: true },
        });
        for (const g of grants) implied.add(g.workspaceId);
      }
      // scope 'system' (pod-wide kind) / 'user' → no workspace signal.
    }
    if (hadOntologySignal) {
      const map = await getMemberMap();
      // I2: never surface a workspace the caller isn't a member of.
      const visible = [...implied].filter((id) => map.has(id));
      if (visible.length === 1) {
        const w = map.get(visible[0])!;
        return {
          workspaceId: w.id,
          rung: 2,
          reason: `only workspace '${w.name}' has ${describeSlugs(slugs)} enabled`,
          confidence: 1,
          candidates: [],
          ask: false,
        };
      }
      if (visible.length > 1) {
        candidates = visible.map((id) => ({ id, name: map.get(id)!.name }));
        // fall through — a later rung (context/relational/AI) may tie-break.
      }
      // 0 visible → the role exists only where the caller isn't a member: no
      // signal, and (I2) we do NOT expose those workspaces.
    }
  }

  const inCandidates = (id: string) =>
    candidates.length === 0 || candidates.some((c) => c.id === id);

  // ── Rung 3 — context-implied (channel binding → focus session) ──
  if (input.context?.channelId || input.context?.sessionId) {
    const map = await getMemberMap();
    if (input.context.channelId) {
      const ch = await db.query.channels.findFirst({
        where: eq(channels.id, input.context.channelId),
        columns: { workspaceId: true },
      });
      if (
        ch?.workspaceId &&
        map.has(ch.workspaceId) &&
        inCandidates(ch.workspaceId)
      ) {
        const w = map.get(ch.workspaceId)!;
        return {
          workspaceId: w.id,
          rung: 3,
          reason: `channel is bound to workspace '${w.name}'`,
          confidence: 1,
          candidates: [],
          ask: false,
        };
      }
    }
    if (input.context.sessionId) {
      const fsRow = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, input.context.sessionId),
        columns: { workspaceId: true },
      });
      if (
        fsRow?.workspaceId &&
        map.has(fsRow.workspaceId) &&
        inCandidates(fsRow.workspaceId)
      ) {
        const w = map.get(fsRow.workspaceId)!;
        return {
          workspaceId: w.id,
          rung: 3,
          reason: `active focus session is in workspace '${w.name}'`,
          confidence: 1,
          candidates: [],
          ask: false,
        };
      }
    }
  }

  // ── Rung 4 — relational gravity (the lens of linked entities) ──
  // Two signals: (a) the linked entities' own workspaces, and (b) the `feeds`
  // edge graph (wired below) — a DECLARED provider/feeds-source tie-breaks an
  // otherwise-ambiguous candidate set toward the source-of-truth workspace.
  if (input.relatedEntityIds && input.relatedEntityIds.length > 0) {
    const map = await getMemberMap();
    const rows = await db.query.entities.findMany({
      where: and(
        inArray(entities.id, input.relatedEntityIds),
        isNull(entities.deletedAt)
      ),
      columns: { workspaceId: true },
    });
    const linked = new Set<string>();
    for (const r of rows) {
      if (
        r.workspaceId &&
        map.has(r.workspaceId) &&
        inCandidates(r.workspaceId)
      ) {
        linked.add(r.workspaceId);
      }
    }
    if (linked.size === 1) {
      const id = [...linked][0];
      const w = map.get(id)!;
      return {
        workspaceId: w.id,
        rung: 4,
        reason: `linked entities all live in workspace '${w.name}'`,
        confidence: 1,
        candidates: [],
        ask: false,
      };
    }
    if (linked.size > 1 && candidates.length === 0) {
      candidates = [...linked].map((id) => ({ id, name: map.get(id)!.name }));
    }
  }

  // ── Rung 4 (feeds seam) — a DECLARED provider/feeds-source tie-breaks the
  // candidate set toward the source-of-truth workspace. Reads the materialized
  // `workspace --feeds--> workspace` edge graph (links), never re-parsing JSONB.
  // STRICTLY additive: only consulted when a prior rung left >1 candidates (real
  // ambiguity), and it only ever PICKS one of those already-valid candidates —
  // honouring the feeds invariant "lens propagation, never data movement". A
  // clean single-winner (rungs 1–3, or rung-4 relational) is never touched, so
  // existing data with a deterministic placement is never re-routed.
  if (candidates.length > 1 && ambient) {
    const providers = await loadFeedsProviders(db, ambient, slugs);
    const preferred = candidates.filter((c) => providers.has(c.id));
    if (preferred.length === 1) {
      const w = preferred[0];
      const map = await getMemberMap();
      const ambientName = map.get(ambient)?.name ?? "this workspace";
      return {
        workspaceId: w.id,
        rung: 4,
        reason: `workspace '${ambientName}' consumes '${w.name}' (declared feeds edge) → placed in the source-of-truth workspace`,
        confidence: 1,
        candidates: [],
        ask: false,
      };
    }
  }

  // ── Rung 5 — AI tie-break (over candidates only; may abstain → ASK) ──
  if (input.aiHint?.workspaceId && ambient) {
    const allowedIds =
      candidates.length > 0
        ? candidates.map((c) => c.id)
        : await loadRoutingMemberIds(db, input.userId);
    const routing = resolveCaptureRouting({
      mode: input.mode ?? "auto",
      aiWorkspaceId: input.aiHint.workspaceId,
      aiConfidence: input.aiHint.confidence ?? null,
      aiReason: input.aiHint.reason ?? null,
      currentWorkspaceId: ambient,
      memberWorkspaceIds: allowedIds,
      minConfidence: input.minConfidence,
    });
    // RATIFIED: rung 5 PROPOSES, it never ACTS.
    //
    // Rungs 1–4 are deterministic (explicit id, ontology, context, relational)
    // and still place data outright. Rung 5 is an AI GUESS, and a guess must
    // not silently relocate a user's data into another lens. No comparable tool
    // lets a heuristic act as a scope — kubectl, gcloud, AWS, Azure, Pulumi,
    // Terraform, Vercel and gh all require the scope to be explicit or
    // configured, and Terraform documents this exact failure mode for
    // TF_WORKSPACE. Heuristics may PROPOSE a pin; they never ARE one.
    //
    // So AUTO (above-gate) and ASK now converge on ONE outcome: `ask: true`,
    // the data STAYS PUT in `ambient`, and the suggestion is surfaced for
    // confirmation. Callers already handling `pendingWorkspaceSwitch` need no
    // change, and a caller that ignores `ask` still cannot drop or misplace the
    // write — it reads `workspaceId` and gets `ambient`, exactly where the data
    // would have landed had the AI never offered a hint. That is why this is
    // safe to ship: the failure mode of ignoring the proposal is "no move",
    // never "no write" and never "wrong lens".
    //
    // The confidence gate above (`resolveCaptureRouting`, auto-tuned per target
    // workspace from correction history) is deliberately PRESERVED — it no
    // longer decides "is this guess good enough to ACT on" but "is it good
    // enough to OFFER". Below-gate / non-member / LOCKED still fall through to
    // rung 6 unchanged, so a weak guess is not even surfaced.
    const suggested =
      routing.movedToWorkspace ??
      routing.pendingWorkspaceSwitch?.suggestedWorkspaceId;
    if (suggested) {
      // Give the ASK chip a real name when we can — load the member floor only
      // if a prior rung didn't already build candidates.
      const map = candidates.length ? null : await getMemberMap();
      const suggestedName =
        candidates.find((c) => c.id === suggested)?.name ??
        map?.get(suggested)?.name ??
        "";
      // CONTRACT: `candidates[0]` IS the suggested workspace. The one consumer
      // (capture's `pendingWorkspaceSwitch` mapping) reads `candidates[0].id`
      // as the suggestion, so a candidate set that merely CONTAINS the
      // suggestion elsewhere in the list would surface the wrong workspace to
      // the user. Hoist it to the front rather than relying on set order.
      const ordered = candidates.length
        ? [
            { id: suggested, name: suggestedName },
            ...candidates.filter((c) => c.id !== suggested),
          ]
        : [{ id: suggested, name: suggestedName }];
      return {
        workspaceId: ambient,
        rung: 5,
        reason:
          input.aiHint.reason ??
          routing.pendingWorkspaceSwitch?.reason ??
          "AI suggests a different workspace (awaiting confirmation)",
        confidence:
          input.aiHint.confidence ??
          routing.pendingWorkspaceSwitch?.confidence ??
          BYOA_DEFAULT_ROUTE_CONFIDENCE,
        candidates: ordered,
        ask: true,
      };
    }
    // AUTO below-gate / non-member / LOCKED → fall through to the default.
  }

  // ── Rung 6 — entity-scope default (the ONE K1 precedence) ──
  // Prefer explicit input; when omitted, resolve from the kind profile so
  // process kinds (entityScope workspace) still ambient-pin and identity
  // kinds stay pod-wide. Missing profile → normalizeEntityScope → pod.
  let resolvedEntityScope: string | null | undefined = input.entityScope;
  if (resolvedEntityScope == null && input.kindSlug) {
    try {
      resolvedEntityScope = await new ProfileResolutionService(
        db
      ).getEntityScope(input.kindSlug, ambient);
    } catch {
      resolvedEntityScope = null;
    }
  }
  const ws = resolveEntityWorkspacePlacement({
    global: false, // handled at rung 1
    targetWorkspaceId: undefined, // handled at rung 1
    workspaceScoped: input.workspaceScopedFlag === true,
    profileEntityScope: resolvedEntityScope ?? null,
    ambientWorkspaceId: ambient,
  });
  const reason = input.workspaceScopedFlag
    ? "workspace-scoped flag → the ambient workspace"
    : normalizeEntityScope(resolvedEntityScope) === "pod"
      ? "kind is pod-wide → visible everywhere"
      : ambient
        ? "default to the ambient workspace"
        : "no ambient workspace → pod-wide";
  return {
    workspaceId: ws,
    rung: 6,
    reason,
    confidence: 1,
    candidates,
    ask: false,
  };
}
