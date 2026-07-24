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
 * COMPOSE IS TRANSITIVE. A dependency template that ITSELF declares `compose`
 * is an overlay, and it stays one no matter how it was reached. When we
 * `require` such a template (e.g. `the-arch` requires `grants`, and `grants`
 * declares `compose: operations`), we resolve ITS base first and layer it onto
 * that base — we do NOT materialize it as a standalone workspace. Doing so used
 * to create a rogue "Grants Pipeline" workspace whose `subtype: operations`
 * then COLLIDED with the real Operations workspace in `findWorkspaceBySubtype`,
 * making every later compose target a coin-flip between the two.
 *
 * Semantics enforced here:
 *   - Only `kind:'workspace'` dependencies can be `compose`d.
 *   - At most ONE `compose` dependency per package — at EVERY level, not just
 *     the top (else a clear error).
 *   - Dependencies are processed deps-first (a base template's own dependencies
 *     are ensured before the base installs/composes), with a slug-keyed cycle guard.
 *
 * A nested `compose` still never sets `composeTargetWorkspaceId`: that field is
 * the TOP-LEVEL package's own overlay target (what the CALLER layers itself
 * onto). A nested overlay is composed HERE, by this module, onto its own base.
 *
 * This is a pure composition layer: workspace materialization is delegated to
 * `createWorkspaceFromDefinitionIdempotent` (the canonical idempotent create
 * path) and overlay layering to `composeOntoBaseWorkspace` (the ONE compose
 * door, shared with `materializeWorkspaceCore`) — neither is reimplemented here.
 * Presence resolution is access-gated by relation: a `compose` base only counts
 * if the acting user has an editor+ role on it (composing writes onto it, so it
 * can never widen access), while a `require` base only needs to be visible
 * (nothing is written), so an existing base is reused instead of a duplicate
 * being installed.
 *
 * RECURSION SAFETY (why this does NOT route through `materializeWorkspaceCore`):
 * that service's Step 0 IS `resolvePackageDependencies`. Calling it from here
 * would re-enter the resolver with a FRESH `path` (ancestor chain) and a fresh
 * `resolved` cache — defeating both the cycle guard and the diamond dedup that
 * make this walk terminate, and double-recording `installed[]`. Instead the
 * transitive compose reuses the base that step 3's EXISTING recursion already
 * ensured under the SHARED guard, and calls only the compose primitive. No new
 * recursion is introduced: the graph walk is still exactly step 3's.
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
import { resolveWorkspaceTemplate } from "./capabilities/resolve-workspace-template.js";
import type { PackageDefinitionOutput } from "@synap-core/workspace-templates";
import { createWorkspaceFromDefinitionIdempotent } from "./workspace-creation-service.js";
import { composeOntoBaseWorkspace } from "./compose-overlay.js";
import {
  applyPackagePostWorkspace,
  type PackagePostWorkspaceBody,
} from "./package-apply-post-workspace.js";
import {
  createCapabilityFromDefinition,
  loadCapabilityTemplate,
} from "./capabilities/create-from-definition.js";
import { createHubProtocolCallerContext } from "../routers/hub-protocol/utils.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "package-dependency-resolver" });

/**
 * Outcome of seeding ONE dependency's post-workspace layers (capabilities +
 * playbooks) — surfaced up through `ResolvedPackageDependency.seedOutcome` so
 * a caller (CLI/browser) can see "3/4 capabilities seeded; X FAILED: <reason>"
 * instead of the failure being swallowed into a log line only an operator
 * with server access could see. Seeding itself stays NON-FATAL — the install
 * still succeeds — but the outcome is now VISIBLE, never silent.
 */
export interface DependencySeedOutcome {
  slug: string;
  /** No `capabilities`/`playbooks` declared for this template — nothing to seed. */
  status: "no-layers" | "seeded" | "failed";
  /** Layer keys `applyPackagePostWorkspace` reported (e.g. ["capabilities","playbooks"]). */
  layers?: string[];
  /** Failure reason, set only when `status === "failed"`. */
  error?: string;
}

/**
 * Seed a materialized DEPENDENCY's post-workspace layers.
 *
 * A dependency is materialized from a workspace-shaped definition (§4a/§4b),
 * which — by design — carries only the workspace shape (profiles/views/bento):
 * it DROPS the `capabilities` / `automations` / `playbooks` / `loops` layers
 * that the PACKAGE-shaped definition emits. So a `require: grants` dependency
 * stood up its workspace but silently never got its 4 grant capabilities, on
 * BOTH install doors (the resolver runs under Hub `packages/apply` AND tRPC
 * `createFromDefinition`). The post-workspace layers only ran for the TOP-LEVEL
 * package a Hub apply targeted — never for its dependencies.
 *
 * Fix: after a dependency is NEWLY materialized, run the SAME shared door
 * (`applyPackagePostWorkspace`) that a top-level Hub apply runs, with the dep's
 * OWN package definition. A required dependency now gets exactly the treatment
 * a directly-installed package gets — one door, symmetric on both sides.
 *
 * Idempotent + non-fatal: the shared door reuses existing capabilities by key,
 * governed writes may return `proposed` (normal), and a failure here must never
 * abort the install — the workspace already exists. `preResolved` lets a
 * caller that already resolved this slug's template (step 3/4 below) pass the
 * SAME cache-first-resolved package definition through instead of resolving
 * it a second time.
 */
async function seedDependencyPostWorkspace(
  workspaceId: string,
  slug: string,
  userId: string,
  agentUserId: string | undefined,
  preResolved?: PackageDefinitionOutput
): Promise<DependencySeedOutcome> {
  let pkg: PackageDefinitionOutput;
  if (preResolved) {
    pkg = preResolved;
  } else {
    const resolved = await resolveWorkspaceTemplate(slug);
    if (!resolved) return { slug, status: "no-layers" }; // no package form — nothing to seed
    pkg = resolved.packageDefinition;
  }
  // A package definition emits `capabilities` (from the template's
  // `integrations`) and `playbooks` — the two post-workspace layers a template
  // authors. Both are dropped by the workspace-shaped definition; these are
  // what we seed.
  const hasLayers = !!pkg.capabilities?.length || !!pkg.playbooks?.length;
  if (!hasLayers) return { slug, status: "no-layers" };

  try {
    const result = await applyPackagePostWorkspace({
      workspaceId,
      body: pkg as unknown as PackagePostWorkspaceBody,
      userId,
      agentUserId,
      // The resolver runs under both an operator (tRPC) and an agent (Hub)
      // install; capability creation is `checkPermissionOrPropose`-governed, so
      // it self-scopes (created for an authorized owner, else proposed). No
      // agent scopes to forward on the operator path.
      scopes: [],
    });
    logger.info(
      { slug, workspaceId, layers: Object.keys(result) },
      "dependency post-workspace layers seeded"
    );
    return { slug, status: "seeded", layers: Object.keys(result) };
  } catch (err) {
    logger.warn(
      { err, slug, workspaceId },
      "dependency post-workspace layers failed (non-fatal — workspace already exists)"
    );
    return {
      slug,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Editor+ roles that may host a compose overlay (write-gate floor). */
const WRITE_ROLES = new Set(["owner", "admin", "editor"]);

/**
 * What happened to a single dependency during resolution.
 *   - `found`          — a matching artifact already existed on the pod.
 *   - `installed`      — a built-in `workspace` template was materialized now.
 *   - `composed`       — the dependency is itself an OVERLAY (its template
 *                        declares `compose`), so it was layered ADDITIVELY onto
 *                        its base instead of being materialized as its own
 *                        workspace. `workspaceId` is the BASE's id.
 *   - `required-absent`— required but not present, and not auto-installable (surfaced).
 *
 * (A `compose` base surfaces as `found`/`installed` — it's the base that is
 * found/installed; the OVERLAY is what composes onto it. The workspace-level
 * `status:"composed"` in the apply response captures the TOP-LEVEL package's
 * own overlay outcome; this `composed` action captures a DEPENDENCY's.)
 */
export type PackageDependencyAction =
  "found" | "installed" | "composed" | "required-absent";

export interface ResolvedPackageDependency {
  slug: string;
  kind: PackageDependencyKind;
  relation: PackageDependencyRelation;
  /** Resolved workspace id (present for `workspace`-kind deps that resolved). */
  workspaceId?: string;
  action: PackageDependencyAction;
  /** Human context — set for `required-absent` (why it couldn't be satisfied). */
  message?: string;
  /**
   * Post-workspace layer (capabilities/playbooks) seed result for this
   * dependency — set for `installed`/`composed` actions where seeding was
   * attempted. Surfaces a failure that used to be swallowed into a log line.
   */
  seedOutcome?: DependencySeedOutcome;
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
 * Find a workspace whose `settings.workspaceSubtype` matches `slug` that the
 * user may use as a dependency target. `requireWrite` picks the access floor:
 *   - `true` (compose): editor+ ONLY — the overlay WILL write onto this base,
 *     so a viewer-only membership must never be hijacked as a compose target.
 *   - `false` (require): ANY visible membership — presence is all that's needed
 *     (nothing is written), so an existing base is REUSED rather than a
 *     duplicate being installed for a user who can only view it.
 * Deterministic when several match: prefer a workspace the user owns, then the
 * most recently created. Ambiguity is logged.
 */
async function findWorkspaceBySubtype(
  slug: string,
  userId: string,
  requireWrite: boolean
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

  // compose writes onto the base → editor+ floor; require only needs presence.
  const matches = requireWrite
    ? rows.filter((r) => WRITE_ROLES.has(r.role))
    : rows;
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const aOwner = a.ownerId === userId ? 1 : 0;
    const bOwner = b.ownerId === userId ? 1 : 0;
    if (aOwner !== bOwner) return bOwner - aOwner;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  if (matches.length > 1) {
    logger.warn(
      {
        slug,
        userId,
        requireWrite,
        count: matches.length,
        chosen: matches[0].id,
        candidates: matches.map((w) => w.id),
      },
      "Multiple workspaces match dependency subtype — chose deterministically (owner, then most-recent)"
    );
  }

  return { id: matches[0].id };
}

/**
 * Enforce the compose constraints on ONE template's `dependencies[]` and return
 * its single `compose` dep (or undefined). Applied at EVERY level of the graph —
 * the top-level package AND each dependency template — so an overlay's own
 * declaration is validated identically no matter how it is reached.
 *
 * `label` names the declaring template in the error (the package itself at the
 * top level, the dependency's slug when nested).
 */
function assertSingleComposeDep(
  deps: TemplateDependency[],
  label?: string
): TemplateDependency | undefined {
  const composeDeps = deps.filter(
    (d) => (d.relation ?? "require") === "compose"
  );
  const where = label ? ` (declared by "${label}")` : "";
  if (composeDeps.length > 1) {
    throw new Error(
      `A package may declare at most one 'compose' dependency${where}; found ${composeDeps.length}: ${composeDeps
        .map((d) => d.slug)
        .join(", ")}`
    );
  }
  const composeDep = composeDeps[0];
  if (composeDep && (composeDep.kind ?? "workspace") !== "workspace") {
    throw new Error(
      `compose dependency "${composeDep.slug}" must be kind:'workspace' (got '${composeDep.kind}')${where}`
    );
  }
  return composeDep;
}

/**
 * Ensure a `kind:'capability'` dependency is present on the pod for `userId`.
 *
 * A capability dependency is a SIBLING artifact (not a workspace overlay): a
 * suite/package that `require`s a capability wants that capability provisioned,
 * not merely flagged absent. We resolve the capability's template from the pod's
 * CP-synced catalog cache (`loadCapabilityTemplate`, the SAME loader the working
 * embedded-`integrations[]` path uses in `applyPackagePostWorkspace`) and install
 * it through the canonical GOVERNED applier `createCapabilityFromDefinition` — no
 * capability installer is reinvented here.
 *
 * Scope: pod-wide by construction. `createCapabilityFromDefinition` self-scopes
 * (a pod-scoped capability's vault/tools/skills get `workspace_id = null`), and a
 * bare dependency has no host workspace to attach to, so the caller context is
 * built with `workspaceId = null`. The applier is idempotent by key, so a
 * capability two suite members both require installs exactly once (diamond-dedup
 * via the shared `resolved` map records it once; even without dedup the applier
 * is a safe add-only no-op on re-apply).
 *
 * NON-FATAL: a template missing from cache, or any applier failure, degrades to
 * `required-absent` for THIS dep with a clear message — it never throws, so one
 * unsynced/broken capability can't abort the whole suite install. A governed
 * defer (`proposed`) is normal and still counts as installed.
 */
async function ensureCapabilityDependencyPresent(
  slug: string,
  userId: string,
  resolved: Map<string, ResolveResult>,
  installed: ResolvedPackageDependency[],
  agentUserId: string | undefined
): Promise<ResolveResult> {
  // Namespaced cache key so a capability slug never collides with a workspace
  // subtype slug in the SHARED `resolved` map (diamond dedup across members).
  const cacheKey = `capability:${slug}`;
  const cached = resolved.get(cacheKey);
  if (cached) return cached;

  const record = (res: ResolveResult): ResolveResult => {
    resolved.set(cacheKey, res);
    installed.push({
      slug,
      kind: "capability",
      relation: "require",
      action: res.action,
      message: res.message,
    });
    return res;
  };

  // Resolve the capability template from the CP-synced catalog cache. Missing
  // from cache THROWS in `loadCapabilityTemplate` — catch it and degrade so the
  // suite install proceeds.
  let definition;
  try {
    definition = await loadCapabilityTemplate(slug);
  } catch (err) {
    return record({
      action: "required-absent",
      message: `Capability template "${slug}" could not be resolved from the Control Plane catalog cache — install it once the CP is reachable + seeded. ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  // Install through the canonical GOVERNED applier. `workspaceId = null` → the
  // applier self-scopes; `agentUserId` (when set) routes writes through the
  // governance membrane (propose instead of auto-apply), same as every other
  // dependency door. A failure here is non-fatal — surface, never throw.
  try {
    const ctx = await createHubProtocolCallerContext(
      userId,
      [],
      null,
      undefined,
      undefined,
      agentUserId
    );
    const r = await createCapabilityFromDefinition(
      definition as Parameters<typeof createCapabilityFromDefinition>[0],
      {},
      ctx
    );
    return record({
      action: "installed",
      message: `Capability "${slug}" installed (key: ${r.capabilityKey}).`,
    });
  } catch (err) {
    return record({
      action: "required-absent",
      message: `Capability "${slug}" could not be installed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

/**
 * Ensure a `kind:'workspace'` dependency is present on the pod for `userId`.
 * Recurses into the template's OWN dependencies first (topological, deps-first)
 * under a slug-keyed ancestor-path cycle guard, then either COMPOSES it onto its
 * base (when the template is itself an overlay) or installs it from its built-in
 * template.
 */
async function ensureWorkspaceDependencyPresent(
  dep: { slug: string; relation: PackageDependencyRelation },
  userId: string,
  path: Set<string>,
  resolved: Map<string, ResolveResult>,
  installed: ResolvedPackageDependency[],
  agentUserId: string | undefined
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
  const record = (
    res: ResolveResult,
    seedOutcome?: DependencySeedOutcome
  ): ResolveResult => {
    resolved.set(slug, res);
    installed.push({
      slug,
      kind: "workspace",
      relation: dep.relation,
      workspaceId: res.workspaceId,
      action: res.action,
      message: res.message,
      seedOutcome,
    });
    return res;
  };

  // 1. Already present → reuse. A `compose` dep needs editor+ on the base (it
  //    writes onto it); a `require` dep only needs the base to exist + be
  //    visible (nothing is written), so it reuses rather than installing a dup.
  const existing = await findWorkspaceBySubtype(
    slug,
    userId,
    dep.relation === "compose"
  );
  if (existing) return record({ workspaceId: existing.id, action: "found" });

  // 2. Resolve the template — CACHE-FIRST (the freshest CP catalog entry a
  //    synced pod knows about), frozen-bundle fallback on any cache miss.
  //    Absent from BOTH → surface (V1: built-in/cached bases only).
  const resolvedTemplate = await resolveWorkspaceTemplate(slug);
  if (!resolvedTemplate) {
    return record({
      action: "required-absent",
      message: `No built-in workspace template "${slug}" — it must be installed on the pod first (V1 resolves built-in bases only).`,
    });
  }

  // 3. Ensure this template's OWN dependencies first (deps-first). Add this
  //    slug to the ancestor path while recursing, then remove it on exit so a
  //    SIBLING re-encountering it (a diamond) is dedup'd, not thrown.
  //    A nested `compose` dep is ensured with the SAME editor+ write floor as a
  //    top-level one (`relation` is forwarded), and its resolved base id is
  //    captured below — that is what makes compose TRANSITIVE in step 4.
  const baseDeps = resolvedTemplate.dependencies;
  const ownComposeDep = assertSingleComposeDep(baseDeps, slug);
  let ownComposeBase: ResolveResult | undefined;

  path.add(slug);
  try {
    for (const nested of baseDeps) {
      const nestedKind = nested.kind ?? "workspace";
      // A capability a base template itself requires installs too (recursive):
      // resolve + install it through the same canonical door, idempotent + non-fatal.
      if (nestedKind === "capability") {
        await ensureCapabilityDependencyPresent(
          nested.slug,
          userId,
          resolved,
          installed,
          agentUserId
        );
        continue;
      }
      if (nestedKind !== "workspace") continue;
      const nestedRes = await ensureWorkspaceDependencyPresent(
        { slug: nested.slug, relation: nested.relation ?? "require" },
        userId,
        path,
        resolved,
        installed,
        agentUserId
      );
      if (ownComposeDep && nested.slug === ownComposeDep.slug) {
        ownComposeBase = nestedRes;
      }
    }
  } finally {
    path.delete(slug);
  }

  // The templates package's WorkspaceDefinitionInput is structurally the
  // create/reconcile input; cast across the two package boundaries as the boot
  // reconcile hook does.
  const definition =
    resolvedTemplate.workspaceDefinition as unknown as WorkspaceDefinitionInput;

  // 4a. TRANSITIVE COMPOSE — this template is an OVERLAY (it declares its own
  //     `compose`), so it must be layered onto its base, NEVER materialized as
  //     a standalone workspace (that is the rogue-workspace bug). The base was
  //     just ensured by step 3 under the shared cycle guard; reuse its id.
  if (ownComposeDep) {
    if (!ownComposeBase?.workspaceId) {
      // Base unresolvable → surface, never fatal, and never fall back to
      // creating the overlay standalone (it would collide on subtype).
      return record({
        action: "required-absent",
        message: `Overlay "${slug}" composes onto "${ownComposeDep.slug}", which could not be resolved — install "${ownComposeDep.slug}" first.`,
      });
    }
    // The ONE compose door — same primitive `materializeWorkspaceCore` drives.
    await composeOntoBaseWorkspace({
      composeTargetWorkspaceId: ownComposeBase.workspaceId,
      userId,
      definition,
    });
    // The overlay's own capabilities/automations/playbooks/loops attach to the
    // base workspace it composed onto (e.g. grants' 4 grant capabilities land on
    // Operations). composeOntoBaseWorkspace reconciles only the workspace shape,
    // so seed the post-workspace layers here — the same door a top-level apply runs.
    const seedOutcome = await seedDependencyPostWorkspace(
      ownComposeBase.workspaceId,
      slug,
      userId,
      agentUserId,
      resolvedTemplate.packageDefinition
    );
    return record(
      {
        workspaceId: ownComposeBase.workspaceId,
        action: "composed",
        message: `Overlay "${slug}" composed onto "${ownComposeDep.slug}".`,
      },
      seedOutcome
    );
  }

  // 4b. Install via the canonical idempotent create path.
  //     `proposalId` is the BARE TEMPLATE SLUG — the same key the Hub door
  //     (`POST /api/hub/packages/apply`, i.e. `synap launch`) writes as
  //     `body._meta.slug`. The two doors MUST agree: this resolver used to
  //     hand-roll `${slug}-v1`, so a template installed by `synap launch`
  //     (key "builder-workspace") was invisible to a later `require` from this
  //     resolver (key "builder-workspace-v1") → a DUPLICATE workspace. The
  //     template registry is keyed by `meta.slug`, so `slug` here IS the same
  //     identity `_meta.slug` carries. NOT the template's YAML
  //     `workspace.proposalId`: that field is inert on the create path
  //     (`createWorkspaceFromDefinition` never reads it) and is NOT unique —
  //     `internal-runbook.yaml` declares `operations-v1`, which `operations`
  //     itself derives, so keying on it would make installing internal-runbook
  //     idempotently return the OPERATIONS workspace.
  const ws = await createWorkspaceFromDefinitionIdempotent({
    definition,
    userId,
    proposalId: slug,
    packageSlug: slug,
    templateId: slug,
    createdBy: "provisioning",
  });
  // Only for a NEWLY created dependency: the workspace-shaped definition (used
  // just above) drops the capabilities/automations/playbooks/loops layers, so
  // seed them via the shared door. A `found` (idempotent reuse) already went
  // through this on its first creation — skip to avoid needless governed re-writes.
  const seedOutcome = ws.created
    ? await seedDependencyPostWorkspace(
        ws.workspaceId,
        slug,
        userId,
        agentUserId,
        resolvedTemplate.packageDefinition
      )
    : undefined;
  return record(
    {
      workspaceId: ws.workspaceId,
      action: ws.created ? "installed" : "found",
    },
    seedOutcome
  );
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

  // ── Compose-cardinality + kind constraints (same rule at every level) ────
  const composeDep = assertSingleComposeDep(deps);

  const composeRequested = !!composeDep;
  let composeTargetWorkspaceId: string | undefined;

  for (const dep of deps) {
    const kind: PackageDependencyKind = dep.kind ?? "workspace";
    const relation: PackageDependencyRelation = dep.relation ?? "require";

    if (kind === "capability") {
      // Capability deps are require-only siblings — resolve + install through
      // the canonical governed applier (idempotent by key, non-fatal on miss).
      await ensureCapabilityDependencyPresent(
        dep.slug,
        userId,
        resolved,
        installed,
        input.agentUserId
      );
      continue;
    }

    if (kind !== "workspace") {
      // `automation` deps stay require-only surfaced: unlike a capability there is
      // no standalone catalog loader for a bare automation, and an automation is a
      // workspace-scoped WHEN→THEN flow seeded onto a HOST workspace (the package's
      // post-workspace `automations` layer) — a bare dependency has no host to
      // attach to. So there is no symmetric install door; surface, never fatal.
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
      installed,
      input.agentUserId
    );

    if (relation === "compose" && res.workspaceId) {
      composeTargetWorkspaceId = res.workspaceId;
    }
  }

  return { composeTargetWorkspaceId, composeRequested, installed };
}
