/**
 * resolveTarget — the ONE "is there already a space for this apply?" lookup
 * (APPLY-ONE-DOOR-PLAN §1). Every door that installs a template reaches it
 * through `applyTemplate` / `createWorkspaceFromDefinitionIdempotent`; the
 * per-door copies (tRPC by-proposal / by-package_slug, seedPlugin, adopt) are
 * retired onto it in W3/W4.
 *
 * Order (unchanged from the shared core it was lifted out of):
 *   1. key       — `provisioning_proposal_id = proposalId`, a space the caller
 *                  is a member of;
 *   2. holder    — the pod-wide identity holder (0308: a template is installed
 *                  once per pod, a name is held by one active space), returned
 *                  only to a caller who may WRITE it (owner / admin / editor);
 *                  anyone else gets the typed `WorkspaceIdentityConflictError`;
 *   3. legacy    — a space installed before the identity columns existed
 *                  (`findLegacyWorkspaceMatch`).
 *
 * Read-only: adopting a legacy match's key is the caller's write (layer one).
 */
import {
  db,
  drizzleSql,
  workspaceMembers,
  workspaces,
  and,
  eq,
  isNull,
  findWorkspaceIdentityConflict,
  WorkspaceIdentityConflictError,
  readTemplateState,
  type TemplateState,
  type WorkspaceSettings,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "template-apply/resolve-target" });

/**
 * Editor+ roles: who may have an existing space handed back to them (and so
 * have it reconciled / its key adopted). A viewer-only membership must not be
 * able to mutate a space by re-running an install. Mirrors `WRITE_ROLES` in
 * `package-dependency-resolver.ts` (the dependency `require` path relaxes it
 * because REUSE writes nothing; this path writes).
 */
export const ADOPT_WRITE_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "editor",
]);

export interface LegacyWorkspaceMatch {
  id: string;
  settings: WorkspaceSettings | null;
}

/**
 * Fallback identity match for workspaces installed BEFORE migration 0039
 * promoted `proposalId`/`packageSlug` to indexed columns (their
 * `provisioning_proposal_id` is NULL, so the key lookup misses them and a
 * reinstall would DUPLICATE instead of reconciling).
 *
 * Two tiers, UNIONED before the role filter (a viewer-only row in tier 1 must
 * not hide a role-eligible tier-2 row):
 *   1. `workspaces.package_slug = slug`;
 *   2. `settings->>'workspaceSubtype' = slug` (every built-in template sets it).
 *
 * Guardrail on tier 2: overlays set their subtype to their BASE's slug, so a
 * subtype match on an overlay's own slug would adopt the base. Safe here
 * because a compose overlay never reaches this lookup: compose is routed to
 * `composeOntoBaseWorkspace` before it (materialize core + the resolver's
 * transitive compose). When ambiguous, "no match" (create) is the default.
 *
 * Tie-break: owned first, then most recently created.
 */
export async function findLegacyWorkspaceMatch(
  slug: string,
  userId: string
): Promise<LegacyWorkspaceMatch | null> {
  // Archived spaces hold no identity (0308): a reinstall must not resurrect one.
  const live = isNull(workspaces.archivedAt);
  const selectCols = {
    id: workspaces.id,
    ownerId: workspaces.ownerId,
    createdAt: workspaces.createdAt,
    settings: workspaces.settings,
    role: workspaceMembers.role,
  };
  const member = (where: ReturnType<typeof and>) =>
    db
      .select(selectCols)
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.workspaceId, workspaces.id)
      )
      .where(where);

  const bySlug = await member(
    and(
      eq(workspaceMembers.userId, userId),
      eq(workspaces.packageSlug, slug),
      live
    )
  );
  const bySubtype = await member(
    and(
      eq(workspaceMembers.userId, userId),
      drizzleSql`${workspaces.settings}->>'workspaceSubtype' = ${slug}`,
      live
    )
  );

  const byId = new Map<string, (typeof bySlug)[number]>();
  for (const r of [...bySlug, ...bySubtype]) byId.set(r.id, r);
  const matches = [...byId.values()].filter((r) =>
    ADOPT_WRITE_ROLES.has(r.role)
  );
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
        count: matches.length,
        chosen: matches[0].id,
        candidates: matches.map((w) => w.id),
      },
      "findLegacyWorkspaceMatch: multiple legacy workspaces match — chose deterministically (owner, then most-recent)"
    );
  }
  return {
    id: matches[0].id,
    settings: (matches[0].settings ?? null) as WorkspaceSettings | null,
  };
}

export interface ResolveTargetInput {
  userId: string;
  /** The idempotency key (`provisioning_proposal_id`). */
  proposalId?: string;
  packageSlug?: string;
  /** The requested name — the identity of a freehand (slug-less) create. */
  workspaceName?: string;
  /**
   * What to do when a space the caller may NOT write holds the identity:
   * `"throw"` (an apply: the typed 409) or `"report"` (a dry run).
   */
  onForeignHolder?: "throw" | "report";
}

export type ResolvedTarget =
  | { found: false; foreignHolder?: WorkspaceIdentityConflictError }
  | {
      found: true;
      workspaceId: string;
      via: "key" | "holder" | "legacy";
      settings: WorkspaceSettings | null;
      state: TemplateState | null;
    };

async function loadTarget(
  workspaceId: string,
  via: "key" | "holder" | "legacy"
): Promise<ResolvedTarget> {
  const [row] = await db
    .select({
      settings: workspaces.settings,
      packageSlug: workspaces.packageSlug,
      provisioningStatus: workspaces.provisioningStatus,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const settings = (row?.settings ?? null) as WorkspaceSettings | null;
  return {
    found: true,
    workspaceId,
    via,
    settings,
    state: readTemplateState(settings, row),
  };
}

export async function resolveTarget(
  input: ResolveTargetInput
): Promise<ResolvedTarget> {
  const { userId, proposalId, packageSlug } = input;

  // 1. The idempotency key, on a space the caller is a member of.
  if (proposalId) {
    const [hit] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.workspaceId, workspaces.id)
      )
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaces.provisioningProposalId, proposalId)
        )
      )
      .limit(1);
    if (hit) return loadTarget(hit.id, "key");
  }

  // 2. The pod-wide identity holder (0308), BEFORE the legacy fallback, so the
  // real install outranks a caller-owned copy that merely shares the domain.
  // A template install matches by slug only (a different space that merely
  // shares the name is not adopted — the create refuses it as a typed 409); a
  // freehand create matches by name.
  const requestedName = input.workspaceName?.trim();
  const holder = await findWorkspaceIdentityConflict(db, {
    packageSlug: packageSlug ?? null,
    name: packageSlug ? null : (requestedName ?? null),
  });
  if (holder) {
    const [membership] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, holder.existingWorkspaceId),
          eq(workspaceMembers.userId, userId)
        )
      )
      .limit(1);
    if (!membership || !ADOPT_WRITE_ROLES.has(membership.role)) {
      const conflict = new WorkspaceIdentityConflictError(
        holder.field,
        holder.value,
        holder.existingWorkspaceId
      );
      if (input.onForeignHolder === "report")
        return { found: false, foreignHolder: conflict };
      throw conflict;
    }
    return loadTarget(holder.existingWorkspaceId, "holder");
  }

  // 3. A space installed before the identity columns existed.
  if (packageSlug) {
    const legacy = await findLegacyWorkspaceMatch(packageSlug, userId);
    if (legacy) return loadTarget(legacy.id, "legacy");
  }
  return { found: false };
}
