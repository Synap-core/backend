/**
 * Workspace Materialization Service
 * =================================
 *
 * The ONE shared core behind the two workspace-provisioning doors:
 *   1. Hub REST  `POST /api/hub/packages/apply`   (`hub-protocol/rest/packages.ts`)
 *   2. tRPC      `workspaces.createFromDefinition` (`routers/workspaces.ts`)
 *
 * Both doors used to carry a byte-for-byte copy of the SAME two steps:
 *   - "Step 0": resolve the package's template-composition `dependencies[]`
 *     (`resolvePackageDependencies`), and
 *   - the COMPOSE branch: when a `compose` dependency resolved to a base
 *     workspace, layer this package ADDITIVELY onto it via
 *     `reconcileWorkspaceFromDefinition({ mergeCapabilities: true })` (never a
 *     second workspace, never a destructive overwrite).
 *
 * This service is that single source. It is purely the resolve + compose (+
 * idempotent-create) mechanics — it does NOT own the doors' divergent tails:
 *   - error → HTTP/tRPC-code mapping (each door maps the typed errors below to
 *     ITS own status code + body),
 *   - the `auditLog` calls (they differ: Hub stamps `subjectType:"workspace"`,
 *     tRPC stamps `subjectType:"workspaces"`), and
 *   - phase-2 (capabilities/automations/playbooks/loops, seed-docs, progress
 *     events, agent-enroll, project-link) which stays verbatim in each door.
 *
 * Create-path asymmetry (why `deferCreate` exists): the Hub door's no-compose
 * create IS `createWorkspaceFromDefinitionIdempotent` (returns `{workspaceId,
 * created}` — its phase-2 re-queries entities by workspaceId, so it needs no
 * more). The tRPC door's no-compose create is the RICHER
 * `createWorkspaceFromDefinition` (drives `onProgress` events, supports
 * `resumeFrom` chat-first onboarding, and returns `entityIds` its seed-docs
 * step consumes positionally). Those extra outputs can't come from the
 * idempotent wrapper, so the tRPC door passes `deferCreate: true` and performs
 * its own create — the service just resolves + (maybe) composes and hands back.
 */

import {
  type ReconcileReport,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import {
  createWorkspaceFromDefinitionIdempotent,
  type CreateWorkspaceFromDefinitionResult,
} from "./workspace-creation-service.js";
import {
  resolvePackageDependencies,
  type PackageDependencyResolverDefinition,
  type ResolvedPackageDependency,
} from "./package-dependency-resolver.js";
import { composeOntoBaseWorkspace } from "./compose-overlay.js";

/**
 * The compose mechanics now live in `compose-overlay.ts` — the ONE door shared
 * with the resolver's TRANSITIVE compose (a `require`d dependency that itself
 * declares `compose`). Re-exported here so existing importers
 * (`hub-protocol/rest/packages.ts`, `proposals/approve-executors.ts`,
 * `routers/workspaces.ts`) keep their `instanceof` checks working against the
 * SAME class objects.
 */
export {
  ComposeBaseNotFoundError,
  ComposeOverlayError,
} from "./compose-overlay.js";

/**
 * A `compose` dependency was DECLARED but its base workspace could not be
 * resolved (e.g. a private CP-only base with no built-in template). The caller
 * must NOT fall back to creating a rogue overlay workspace — it maps this to a
 * 422 (Hub) / BAD_REQUEST (tRPC) carrying `dependencies`.
 */
export class ComposeBaseUnavailableError extends Error {
  readonly dependencies: ResolvedPackageDependency[];
  constructor(dependencies: ResolvedPackageDependency[]) {
    super("compose base not available");
    this.name = "ComposeBaseUnavailableError";
    this.dependencies = dependencies;
  }
}

/**
 * The resolver rejected the declared graph (cycle / >1 `compose` dep /
 * wrong-kind `compose`). Callers map it to 422 (Hub) / BAD_REQUEST (tRPC) — the
 * same clean validation error both doors surfaced before.
 */
export class DependencyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyResolutionError";
  }
}

export type MaterializeCoreResult =
  | {
      status: "created";
      workspaceId: string;
      dependencies: ResolvedPackageDependency[];
      created: CreateWorkspaceFromDefinitionResult;
    }
  | {
      status: "composed";
      workspaceId: string;
      composeTargetWorkspaceId: string;
      dependencies: ResolvedPackageDependency[];
      reconcile: ReconcileReport;
    }
  | {
      /**
       * No `compose` base resolved AND the caller asked to `deferCreate` — i.e.
       * the tRPC door, which runs its own richer create afterwards. Carries the
       * resolved dependency graph so the caller can still surface it.
       */
      status: "resolved";
      dependencies: ResolvedPackageDependency[];
    };

export interface MaterializeWorkspaceCoreInput {
  /** ALREADY extends-resolved by the caller (see `resolveWorkspaceExtends`). */
  definition: WorkspaceDefinitionInput;
  userId: string;
  agentUserId?: string;
  /** Package/template identity slug for the cycle guard (Hub: `_meta.slug`; tRPC: `packageSlug`). */
  selfSlug?: string;
  /**
   * When true, the no-compose path returns `{status:"resolved"}` WITHOUT
   * creating — the caller (tRPC) performs its own richer create. When false /
   * omitted (Hub), the no-compose path creates via
   * `createWorkspaceFromDefinitionIdempotent` and returns `{status:"created"}`.
   */
  deferCreate?: boolean;
  // ── Idempotent-create passthrough (used only when !deferCreate && no compose) ──
  proposalId?: string;
  workspaceName?: string;
  templateId?: string;
  packageSlug?: string;
  /**
   * Caller-supplied version for `packageSlug` (Hub: `_meta.version`, fetched
   * by the CLI from the authed CP `/mine` for private/uncached templates —
   * `resolveWorkspaceTemplate`'s cache-first lookup never sees a private
   * slug). Forwarded verbatim into `createWorkspaceFromDefinitionIdempotent`,
   * which treats it as a FALLBACK: the cache-resolved version still wins
   * whenever it is present (see that function + `reconcileWorkspaceIfStale`).
   */
  packageVersion?: string;
  workspaceType?: "personal" | "agent" | "project" | "operational";
  createdBy?: "user" | "provisioning" | "plugin";
}

/**
 * Resolve dependencies, then either COMPOSE this package onto a resolved base
 * workspace, or (unless `deferCreate`) idempotently CREATE a new workspace.
 *
 * Throws (callers map to their own status codes):
 *   - `DependencyResolutionError`  — resolver rejected the graph.
 *   - `ComposeBaseUnavailableError`— a `compose` dep declared but base unresolved.
 *   - `ComposeBaseNotFoundError`   — resolved compose base vanished before load.
 *   - anything `reconcileWorkspaceFromDefinition` / `assertWorkspaceWrite` /
 *     `createWorkspaceFromDefinitionIdempotent` throw — propagated verbatim.
 */
export async function materializeWorkspaceCore(
  input: MaterializeWorkspaceCoreInput
): Promise<MaterializeCoreResult> {
  const { definition, userId, agentUserId, selfSlug } = input;

  // ── Step 0: resolve template-composition dependencies ───────────────────
  let resolveResult;
  try {
    resolveResult = await resolvePackageDependencies({
      // Bounded boundary cast: the definition is structurally a superset of the
      // slice the resolver reads (`dependencies` / `workspaceSubtype` / `_meta`)
      // — the same cast both doors performed at this call.
      definition: definition as unknown as PackageDependencyResolverDefinition,
      userId,
      agentUserId,
      selfSlug,
    });
  } catch (e) {
    // Cycle, >1 compose dep, or wrong-kind compose → a typed validation error.
    throw new DependencyResolutionError((e as Error).message);
  }
  const dependencies = resolveResult.installed;

  // A compose was requested but its base could not be resolved. Do NOT fall
  // back to creating a rogue overlay workspace — surface the reason.
  if (
    resolveResult.composeRequested &&
    !resolveResult.composeTargetWorkspaceId
  ) {
    throw new ComposeBaseUnavailableError(dependencies);
  }

  // ── COMPOSE: layer this package ADDITIVELY onto the resolved base ────────
  if (resolveResult.composeTargetWorkspaceId) {
    const composeTargetWorkspaceId = resolveResult.composeTargetWorkspaceId;
    // The ONE compose door (shared with the resolver's transitive compose):
    // loads + write-gates the base, then reconciles ADDITIVELY onto it.
    const reconcile: ReconcileReport = await composeOntoBaseWorkspace({
      composeTargetWorkspaceId,
      userId,
      definition,
    });
    return {
      status: "composed",
      workspaceId: composeTargetWorkspaceId,
      composeTargetWorkspaceId,
      dependencies,
      reconcile,
    };
  }

  // ── No compose base. Either hand back to the caller, or create here. ────
  if (input.deferCreate) {
    return { status: "resolved", dependencies };
  }

  const created = await createWorkspaceFromDefinitionIdempotent({
    definition,
    userId,
    proposalId: input.proposalId,
    workspaceName: input.workspaceName,
    templateId: input.templateId,
    packageSlug: input.packageSlug,
    packageVersion: input.packageVersion,
    workspaceType: input.workspaceType,
    createdBy: input.createdBy,
  });
  return {
    status: "created",
    workspaceId: created.workspaceId,
    dependencies,
    created,
  };
}
