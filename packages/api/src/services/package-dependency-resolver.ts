/**
 * Package Dependency Resolver
 * ===========================
 *
 * The install-time resolver for template-composition dependencies (the
 * Enterprise-OS "template dependencies" feature). Given a `PackageDefinition`
 * about to be applied via `POST /api/hub/packages/apply`, it walks the package's
 * declared `dependencies[]` and builds the pod's template graph:
 *
 *   - `require` (default): the dependency must be PRESENT on the pod as its own
 *     artifact. For a built-in `workspace` template we install it if absent;
 *     otherwise we record it as required-but-absent (surfaced, never fatal).
 *   - `compose`: this package is an OVERLAY on the dependency's workspace. The
 *     base workspace is ensured present (installed from its built-in template if
 *     absent), and its id is returned as `composeTargetWorkspaceId`. The caller
 *     then layers THIS package additively onto it via
 *     `reconcileWorkspaceFromDefinition` — no second workspace is created.
 *
 * Semantics enforced here:
 *   - Only `kind:'workspace'` dependencies can be `compose`d.
 *   - At most ONE `compose` dependency per package (else a clear error).
 *   - Dependencies are processed deps-first (a base template's own dependencies
 *     are ensured before the base installs), with a slug-keyed cycle guard.
 *
 * This is a pure composition layer: workspace materialization is delegated to
 * `createWorkspaceFromDefinitionIdempotent` (the canonical idempotent create
 * path) — never reimplemented here. Presence resolution is write-gated: a
 * pre-existing workspace only counts as the compose base if the acting user has
 * an editor+ role on it, so composing can never widen access.
 */

import {
  db,
  and,
  eq,
  drizzleSql,
  workspaces,
  workspaceMembers,
  type TemplateDependency,
  type PackageDependencyKind,
  type PackageDependencyRelation,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import {
  getWorkspaceTemplate,
  toWorkspaceDefinition,
  type WorkspaceYaml,
} from "@synap-core/workspace-templates";
import { createWorkspaceFromDefinitionIdempotent } from "./workspace-creation-service.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "package-dependency-resolver" });

/** Editor+ roles that may host a compose overlay (write-gate floor). */
const WRITE_ROLES = new Set(["owner", "admin", "editor"]);

/**
 * What happened to a single dependency during resolution.
 *   - `found`          — a matching artifact already existed on the pod.
 *   - `installed`      — a built-in `workspace` template was materialized now.
 *   - `composed`       — the compose base was resolved and set as the overlay target.
 *   - `required-absent`— required but not present, and not auto-installable (surfaced).
 */
export type PackageDependencyAction =
  | "found"
  | "installed"
  | "composed"
  | "required-absent";

export interface ResolvedPackageDependency {
  slug: string;
  kind: PackageDependencyKind;
  relation: PackageDependencyRelation;
  /** Resolved workspace id (present for `workspace`-kind deps that resolved). */
  workspaceId?: string;
  action: PackageDependencyAction;
  /** Human context — set for `required-absent` (why it couldn't be satisfied). */
  message?: string;
}

/** The minimal slice of a `PackageDefinition` this resolver reads. */
export interface PackageDependencyResolverDefinition {
  dependencies?: TemplateDependency[];
  workspaceSubtype?: string;
  _meta?: { slug?: string } | undefined;
}

export interface ResolvePackageDependenciesInput {
  definition: PackageDependencyResolverDefinition;
  userId: string;
  agentUserId?: string;
  /**
   * This package's OWN identity slug, used to seed the cycle guard so a direct
   * self-dependency throws. MUST be the package/template identity — NOT
   * `workspaceSubtype`: overlays deliberately set their subtype to their base's
   * slug, so seeding from subtype would self-collide with the (legitimate)
   * dependency on that base. Callers pass the package slug (Hub: `_meta.slug`;
   * tRPC: `input.packageSlug`).
   */
  selfSlug?: string;
}

/** Outcome of resolving a single dependency (cached for diamond dedup). */
type ResolveResult = {
  workspaceId?: string;
  action: PackageDependencyAction;
  message?: string;
};

export interface ResolvePackageDependenciesResult {
  /**
   * If a `compose` dependency resolved to a base workspace, its id — the caller
   * layers the package additively onto it (instead of creating a new workspace).
   */
  composeTargetWorkspaceId?: string;
  /**
   * True iff a `compose` dependency was DECLARED. When true but
   * `composeTargetWorkspaceId` is unset, the base could not be resolved and the
   * caller must NOT fall back to creating a rogue overlay workspace — it should
   * surface the `required-absent` entry instead.
   */
  composeRequested: boolean;
  /** The resolved dependency graph, in declaration order — for the UX. */
  installed: ResolvedPackageDependency[];
}

/**
 * Find a workspace the user can WRITE whose `settings.workspaceSubtype` matches
 * `slug`. Deterministic when several match: prefer a workspace the user owns,
 * then the most recently created. Ambiguity is logged. Returns null when none
 * match OR the user lacks an editor+ role on every match (so a viewer-only
 * membership can never be hijacked as a compose base).
 */
async function findWritableWorkspaceBySubtype(
  slug: string,
  userId: string
): Promise<{ id: string } | null> {
  const rows = await db
    .select({
      id: workspaces.id,
      ownerId: workspaces.ownerId,
      createdAt: workspaces.createdAt,
      role: workspaceMembers.role,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id)
    )
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        drizzleSql`${workspaces.settings}->>'workspaceSubtype' = ${slug}`
      )
    );

  const writable = rows.filter((r) => WRITE_ROLES.has(r.role));
  if (writable.length === 0) return null;

  writable.sort((a, b) => {
    const aOwner = a.ownerId === userId ? 1 : 0;
    const bOwner = b.ownerId === userId ? 1 : 0;
    if (aOwner !== bOwner) return bOwner - aOwner;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  if (writable.length > 1) {
    logger.warn(
      {
        slug,
        userId,
        count: writable.length,
        chosen: writable[0].id,
        candidates: writable.map((w) => w.id),
      },
      "Multiple workspaces match dependency subtype — chose deterministically (owner, then most-recent)"
    );
  }

  return { id: writable[0].id };
}

/**
 * Ensure a `kind:'workspace'` dependency is present on the pod for `userId`,
 * installing it from its built-in template when absent. Recurses into the base
 * template's OWN dependencies first (topological, deps-first) under a slug-keyed
 * cycle guard.
 */
async function ensureWorkspaceDependencyPresent(
  dep: { slug: string; relation: PackageDependencyRelation },
  userId: string,
  path: Set<string>,
  resolved: Map<string, ResolveResult>,
  installed: ResolvedPackageDependency[]
): Promise<ResolveResult> {
  const { slug } = dep;

  // Cycle: this slug is already on the current DFS ANCESTOR path (not merely
  // "seen before") — that is a true cycle. A legitimate diamond (two independent
  // edges into the same node) is NOT on the ancestor path, so it doesn't throw.
  if (path.has(slug)) {
    throw new Error(
      `Cyclic template dependency detected: "${slug}" is its own ancestor (path: ${[
        ...path,
        slug,
      ].join(" → ")})`
    );
  }
  // Diamond dedup: already resolved on another branch — reuse, never re-run/re-throw.
  const cached = resolved.get(slug);
  if (cached) return cached;

  // Record a fresh resolution once (both the cache and the UX `installed[]`).
  const record = (res: ResolveResult): ResolveResult => {
    resolved.set(slug, res);
    installed.push({
      slug,
      kind: "workspace",
      relation: dep.relation,
      workspaceId: res.workspaceId,
      action: res.action,
      message: res.message,
    });
    return res;
  };

  // 1. Already present (and writable) → reuse.
  const existing = await findWritableWorkspaceBySubtype(slug, userId);
  if (existing) return record({ workspaceId: existing.id, action: "found" });

  // 2. Resolve the built-in template. Absent → surface (V1: built-in bases only).
  const tpl = getWorkspaceTemplate(slug);
  if (!tpl) {
    return record({
      action: "required-absent",
      message: `No built-in workspace template "${slug}" — it must be installed on the pod first (V1 resolves built-in bases only).`,
    });
  }

  // 3. Ensure the base template's OWN dependencies first (deps-first). Add this
  //    slug to the ancestor path while recursing, then remove it on exit so a
  //    SIBLING re-encountering it (a diamond) is dedup'd, not thrown.
  path.add(slug);
  try {
    const baseDeps =
      (tpl as WorkspaceYaml & { dependencies?: TemplateDependency[] })
        .dependencies ?? [];
    for (const nested of baseDeps) {
      if ((nested.kind ?? "workspace") !== "workspace") continue;
      await ensureWorkspaceDependencyPresent(
        { slug: nested.slug, relation: nested.relation ?? "require" },
        userId,
        path,
        resolved,
        installed
      );
    }
  } finally {
    path.delete(slug);
  }

  // 4. Install the base via the canonical idempotent create path. The templates
  //    package's WorkspaceDefinitionInput is structurally the create-path input;
  //    cast across the two package boundaries as the boot reconcile hook does.
  const { definition } = toWorkspaceDefinition(slug);
  const ws = await createWorkspaceFromDefinitionIdempotent({
    definition: definition as unknown as WorkspaceDefinitionInput,
    userId,
    proposalId: `${slug}-v1`,
    packageSlug: slug,
    templateId: slug,
    createdBy: "provisioning",
  });
  return record({
    workspaceId: ws.workspaceId,
    action: ws.created ? "installed" : "found",
  });
}

/**
 * Resolve a package's declared `dependencies[]` into the pod's template graph.
 * See the module header for full semantics.
 */
export async function resolvePackageDependencies(
  input: ResolvePackageDependenciesInput
): Promise<ResolvePackageDependenciesResult> {
  const { definition, userId } = input;
  const deps = definition.dependencies ?? [];
  const installed: ResolvedPackageDependency[] = [];

  if (deps.length === 0) {
    return { composeRequested: false, installed };
  }

  // Cycle guard: `path` is the current DFS ancestor chain, seeded with THIS
  // package's OWN identity slug so a direct self-dependency throws. NEVER seed
  // from `workspaceSubtype` — overlays set subtype = their base's slug, which
  // would self-collide with the (legitimate) dependency on that base.
  const selfSlug = input.selfSlug ?? definition._meta?.slug;
  const path = new Set<string>();
  if (selfSlug) path.add(selfSlug);
  const resolved = new Map<string, ResolveResult>();

  // ── Compose-cardinality + kind constraints ──────────────────────────────
  const composeDeps = deps.filter(
    (d) => (d.relation ?? "require") === "compose"
  );
  if (composeDeps.length > 1) {
    throw new Error(
      `A package may declare at most one 'compose' dependency; found ${composeDeps.length}: ${composeDeps
        .map((d) => d.slug)
        .join(", ")}`
    );
  }
  const composeDep = composeDeps[0];
  if (composeDep && (composeDep.kind ?? "workspace") !== "workspace") {
    throw new Error(
      `compose dependency "${composeDep.slug}" must be kind:'workspace' (got '${composeDep.kind}')`
    );
  }

  const composeRequested = !!composeDep;
  let composeTargetWorkspaceId: string | undefined;

  for (const dep of deps) {
    const kind: PackageDependencyKind = dep.kind ?? "workspace";
    const relation: PackageDependencyRelation = dep.relation ?? "require";

    if (kind !== "workspace") {
      // capability/automation deps are require-only; V1 has no built-in install
      // path for them here — surface as required-but-absent, never fatal.
      installed.push({
        slug: dep.slug,
        kind,
        relation: "require",
        action: "required-absent",
        message: `${kind} dependency "${dep.slug}" is not auto-verified in V1 — ensure it is installed on the pod.`,
      });
      continue;
    }

    // ensureWorkspaceDependencyPresent handles cycle detection (ancestor path),
    // diamond dedup, and recording into `installed[]` exactly once.
    const res = await ensureWorkspaceDependencyPresent(
      { slug: dep.slug, relation },
      userId,
      path,
      resolved,
      installed
    );

    if (relation === "compose" && res.workspaceId) {
      composeTargetWorkspaceId = res.workspaceId;
    }
  }

  return { composeTargetWorkspaceId, composeRequested, installed };
}
