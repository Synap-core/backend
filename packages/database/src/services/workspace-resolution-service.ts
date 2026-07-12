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
 *   5. AI tie-break — ONLY over the reduced candidate set (or, absent candidates,
 *                    the member set); may abstain → ASK, never a silent guess.
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

type Db = PostgresJsDatabase<typeof schema>;

// ── The moved K1 primitives (one implementation, re-exported by @synap/api) ──

/**
 * Which workspace TYPES may be offered as AUTO-routing candidates for captured
 * user data. Excludes `operational` (system/admin surfaces) and `agent`
 * (ratified decision D2). Explicit `workspaceId` targeting elsewhere is
 * unaffected. Archival is orthogonal (`archivedAt IS NULL`, enforced below).
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
export function resolveEntityWorkspacePlacement(input: {
  global: boolean;
  targetWorkspaceId?: string | null;
  workspaceScoped: boolean;
  /** The profile's `entityScope` ("pod" | "workspace"); defaults to "workspace". */
  profileEntityScope?: string | null;
  /** The governance/ambient workspace (targetWorkspaceId ?? ctx.workspaceId ?? null). */
  ambientWorkspaceId: string | null;
}): string | null {
  if (input.global) return null;
  if (input.targetWorkspaceId) return input.targetWorkspaceId;
  if (input.workspaceScoped) return input.ambientWorkspaceId;
  const scope = input.profileEntityScope ?? "workspace";
  return scope === "pod" ? null : input.ambientWorkspaceId;
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
  /** The reduced set surfaced when a rung couldn't pick a single winner. */
  candidates: WorkspaceCandidate[];
  /** ASK mode surfaced a suggestion the caller must confirm before moving. */
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
    columns: { id: true, name: true, workspaceType: true, archivedAt: true },
  });
  for (const w of wsRows) {
    if (!memberIds.has(w.id)) continue; // I2 floor (redundant under SQL, load-bearing under mock)
    if (w.archivedAt) continue;
    if (!isRoutableWorkspaceType(w.workspaceType)) continue;
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
  // Minimal this wave: only the linked entities' own workspaces. SEAM: `feeds`
  // edges become an additional candidate signal in Wave 4 (hook here).
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
    if (routing.movedToWorkspace) {
      return {
        workspaceId: routing.movedToWorkspace,
        rung: 5,
        reason: input.aiHint.reason ?? "AI tie-break selected this workspace",
        confidence: input.aiHint.confidence ?? BYOA_DEFAULT_ROUTE_CONFIDENCE,
        candidates,
        ask: false,
      };
    }
    if (routing.pendingWorkspaceSwitch) {
      const suggested = routing.pendingWorkspaceSwitch.suggestedWorkspaceId;
      // Give the ASK chip a real name when we can — load the member floor only
      // if a prior rung didn't already build candidates.
      const map = candidates.length ? null : await getMemberMap();
      return {
        workspaceId: ambient,
        rung: 5,
        reason:
          routing.pendingWorkspaceSwitch.reason ??
          "AI suggests a different workspace (awaiting confirmation)",
        confidence: routing.pendingWorkspaceSwitch.confidence ?? 0,
        candidates: candidates.length
          ? candidates
          : [{ id: suggested, name: map?.get(suggested)?.name ?? "" }],
        ask: true,
      };
    }
    // AUTO below-gate / non-member / LOCKED → fall through to the default.
  }

  // ── Rung 6 — entity-scope default (the ONE K1 precedence) ──
  const ws = resolveEntityWorkspacePlacement({
    global: false, // handled at rung 1
    targetWorkspaceId: undefined, // handled at rung 1
    workspaceScoped: input.workspaceScopedFlag === true,
    profileEntityScope: input.entityScope ?? null,
    ambientWorkspaceId: ambient,
  });
  const reason = input.workspaceScopedFlag
    ? "workspace-scoped flag → the ambient workspace"
    : (input.entityScope ?? "workspace") === "pod"
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
