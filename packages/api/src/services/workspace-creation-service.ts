/**
 * Workspace Creation Service
 *
 * The idempotent create (`createWorkspaceFromDefinitionIdempotent`, a wrapper
 * over `template-apply/layer-one.ts`), the one-space-per-domain verdict, and —
 * until W4 moves the boot reconcile and adopt onto `applyTemplate` —
 * `reconcileWorkspaceIfStale`. The existing-space lookup lives in
 * `template-apply/resolve-target.ts`; "failed in layer 2 → re-sync" is a
 * `planTemplateApply` state (W3 retired the tRPC copies).
 */
import { unfilteredAiFanoutError } from "@synap-core/types/automations";
import {
  reconcileWorkspaceFromDefinition,
  db,
  drizzleSql,
  workspaceMembers,
  workspaces,
  and,
  eq,
  isNull,
  or,
  findWorkspaceIdentityConflict,
  readTemplateState,
  type ReconcileReport,
  type WorkspaceDefinitionInput,
  type WorkspaceSettings,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  resolveWorkspaceTemplate,
  type ResolvedWorkspaceTemplate,
} from "./capabilities/resolve-workspace-template.js";
import { oneSpacePerDomainGuidance } from "./one-space-per-domain.js";
import {
  applyLayerOne,
  withWorkspaceProposalIdLock,
  type LayerOneInput,
  type LayerOneResult,
} from "./template-apply/layer-one.js";
import { findLegacyWorkspaceMatch } from "./template-apply/resolve-target.js";

const logger = createLogger({ module: "workspace-creation-service" });

export interface ReconcileIfStaleResult {
  /** True iff an actual `reconcileWorkspaceFromDefinition` write happened. */
  reconciled: boolean;
  /**
   * True iff a version COMPARISON was possible (the resolved template carried
   * a version signal) — true even when up-to-date (no-op). Distinguishes
   * "checked, in sync" (caller should do nothing further) from "couldn't
   * check" (caller may fall back to its own legacy behavior).
   */
  checked: boolean;
  report?: ReconcileReport;
  version?: string;
  /**
   * The package definition this reconcile actually ran against — the FRESH
   * server-resolved template, NOT the caller's (possibly stale) copy.
   *
   * A caller that also syncs the post-workspace layers (capabilities /
   * playbooks / automations, via `applyPackagePostWorkspace`) MUST build its
   * body from THIS, not from its own `definition`: layer 1 reconciles against
   * the freshest template, so sourcing layer 2 from a stale caller copy would
   * silently skip a playbook the new template version just added (the workspace
   * would gain the new profile but not the playbook that uses it).
   * Undefined when the reconcile ran off `callerDefinition` (no resolved
   * template) — then the caller's own definition IS the right source.
   */
  packageDefinition?: ResolvedWorkspaceTemplate["packageDefinition"];
  /**
   * Set when layer 1 reconciled to a NEW version: the stamp this pass did NOT
   * write. This function never stamps — the caller hands it to the ONE
   * finisher (`finishTemplateApply`) with its layer-2 result, which stamps it
   * only once layer 2 converged: the stamp says "this space is at template
   * version X", and layer 1 alone has not earned it.
   */
  pendingVersionStamp?: string;
}

/**
 * Version-aware reconcile for an ALREADY-idempotent-hit workspace — the ONE
 * shared entry point BOTH install doors converge on:
 *   - Hub REST `POST /api/hub/packages/apply` → `materializeWorkspaceCore` →
 *     `createWorkspaceFromDefinitionIdempotent` (below), and
 *   - tRPC `workspaces.createFromDefinition`'s own idempotency pre-check
 *     (`reconcileExisting` in `routers/workspaces.ts`).
 * Neither reimplements the compare — both call this.
 *
 * Resolves the FRESHEST template via the cache-first `resolveWorkspaceTemplate`
 * (W2a). CP template versions are content-hash stamps (`"h-<hash>"`), not
 * semver, so a plain string mismatch IS the whole "is there an update" signal
 * (the CP only reissues a new hash when the template content actually
 * changed). Equal ⇒ genuinely nothing to do (skip, `checked:true,
 * reconciled:false`). Different ⇒ `reconcileWorkspaceFromDefinition`
 * (additive, non-destructive — never deletes/mutates existing data), and the
 * new version is handed back as `pendingVersionStamp` — NEVER stamped here
 * (the caller's finisher stamps it once layer 2 converged).
 *
 * Never throws — `checked:false` (no `packageSlug`, template unresolvable, or
 * the resolved template carries no version signal, e.g. a bundle-fallback
 * template) lets the caller fall back to its own legacy behavior for that edge.
 *
 * Governance: reconciles under the SAME `userId` the caller was already
 * authorized as (Hub's agent-acting user, or the tRPC ctx user) — this widens
 * no permission floor beyond what the caller already enforced to reach this
 * idempotent-hit branch in the first place.
 */
export async function reconcileWorkspaceIfStale(opts: {
  workspaceId: string;
  packageSlug: string | undefined;
  currentSettings: WorkspaceSettings | null | undefined;
  userId: string;
  /**
   * Caller-supplied version fallback for slugs the cache-first
   * `resolveWorkspaceTemplate` can't see — private templates never land in
   * the pod's anonymous `cp_catalog_cache`, so `resolved?.version` is always
   * empty for them and this function used to bail with `checked:false`,
   * never stamping `settings.packageVersion`. The CLI fetches a private
   * template's hash version from the authed CP `/mine` and passes it as
   * `_meta.version` (Hub) → `packageVersion` (this service).
   *
   * FALLBACK ONLY: when `resolveWorkspaceTemplate` DOES resolve a version
   * (public/cached templates), that value always wins over this one — a
   * stale caller-supplied version must never override a fresh cache hit.
   */
  callerVersion?: string;
  /** Paired fallback definition — used only when both `resolved` AND its
   * `workspaceDefinition` are unavailable, so a reconcile write has
   * something to apply. */
  callerDefinition?: WorkspaceDefinitionInput;
}): Promise<ReconcileIfStaleResult> {
  const {
    workspaceId,
    packageSlug,
    currentSettings,
    userId,
    callerVersion,
    callerDefinition,
  } = opts;
  if (!packageSlug) return { reconciled: false, checked: false };

  try {
    const resolved = await resolveWorkspaceTemplate(packageSlug);
    // Cache-first: the resolved version always wins when present. Fall back
    // to the caller-supplied version ONLY when the cache yields nothing
    // (private/uncached slug) — never the other way around.
    const version = resolved?.version ?? callerVersion;
    if (!version) return { reconciled: false, checked: false };

    if (version === readTemplateState(currentSettings)?.version) {
      return { reconciled: false, checked: true, version };
    }

    const workspaceDefinition = (resolved?.workspaceDefinition ??
      callerDefinition) as WorkspaceDefinitionInput | undefined;
    if (!workspaceDefinition) {
      // Have a version to compare (caller-supplied) but nothing to
      // reconcile with — report the drift without writing.
      return { reconciled: false, checked: true, version };
    }

    const report = await reconcileWorkspaceFromDefinition({
      validateFlow: unfilteredAiFanoutError,
      workspaceId,
      userId,
      definition: workspaceDefinition,
    });

    // The new version is NOT stamped here: it rides back as
    // `pendingVersionStamp` to the caller's finisher, which stamps it only
    // once layer 2 converged.
    return {
      reconciled: true,
      checked: true,
      report,
      version,
      // Hand back the SAME source layer 1 reconciled against so a caller
      // syncing layer 2 stays in lockstep with it (see the field's doc).
      packageDefinition: resolved?.packageDefinition,
      pendingVersionStamp: version,
    };
  } catch (err) {
    logger.warn(
      { err, workspaceId, packageSlug },
      "reconcileWorkspaceIfStale: version check failed (non-fatal)"
    );
    return { reconciled: false, checked: false };
  }
}

/*
 * NAMED INSTANCES are retired (0308, founder 2026-10-06): a template is
 * installed ONCE per pod — `workspaces_active_package_slug_unique` makes a
 * second active copy impossible — so there is no `<slug>:<name>` key any more.
 * The doors that accepted an instance name answer 400.
 */

/**
 * ONE SPACE PER DOMAIN — the create-time verdict (rule text:
 * `one-space-per-domain.ts`). Every create door that can mint a space calls
 * this BEFORE governance, so a second space of a domain is refused instead of
 * becoming a proposal the user must decline — for EVERY caller, human or
 * agent (founder 2026-10-06: no duplicate spaces, no user link).
 *
 * What is left for this check after 0308: name and template identity are
 * enforced pod-wide by the database and the idempotent create (an exact
 * holder is REUSED, or refused as a typed 409 when the caller cannot write
 * it). This catches the remaining twin — a live space of the same DOMAIN that
 * does not hold the template slug: one whose `workspaceSubtype` or
 * provisioning key names the template (e.g. a copy 0308 detached).
 *   - reuse (key hit, pod-wide identity holder, legacy match) → `create`
 *     (the idempotent create reuses; nothing new is minted);
 *   - a domain twin the caller can see → `refuse` with the typed
 *     `{status:"exists"}` reply;
 *   - otherwise → `create`.
 */
export type OneSpacePerDomainVerdict =
  | { action: "create" }
  | {
      action: "refuse";
      reply: {
        status: "exists";
        workspaceId: string;
        workspaceName: string;
        matchedBy: "template";
        guidance: string;
      };
    };

export async function checkOneSpacePerDomain(input: {
  userId: string;
  packageSlug?: string;
  /** The idempotency key the create would use (the slug, for a template). */
  idempotencyKey?: string;
  workspaceName?: string;
}): Promise<OneSpacePerDomainVerdict> {
  const { userId, packageSlug, idempotencyKey } = input;

  // Would this request REUSE? Then it mints nothing — never refuse a reinstall.
  if (idempotencyKey) {
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
          eq(workspaces.provisioningProposalId, idempotencyKey)
        )
      )
      .limit(1);
    if (hit) return { action: "create" };
  }
  // A pod-wide identity holder: the idempotent create reuses it (or refuses
  // with the typed 409) — never a second space either way.
  if (
    await findWorkspaceIdentityConflict(db, {
      packageSlug: packageSlug ?? null,
      name: packageSlug ? null : (input.workspaceName ?? null),
    })
  ) {
    return { action: "create" };
  }
  if (!packageSlug) return { action: "create" };
  if (await findLegacyWorkspaceMatch(packageSlug, userId)) {
    return { action: "create" };
  }

  const instancePrefix = `${packageSlug}:`;
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      ownerId: workspaces.ownerId,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id)
    )
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        isNull(workspaces.archivedAt),
        or(
          eq(workspaces.provisioningProposalId, packageSlug),
          drizzleSql`left(${workspaces.provisioningProposalId}, ${instancePrefix.length}) = ${instancePrefix}`,
          drizzleSql`${workspaces.settings}->>'workspaceSubtype' = ${packageSlug}`
        )
      )
    );
  const existing = pickExisting(rows, userId);
  if (!existing) return { action: "create" };
  return {
    action: "refuse",
    reply: {
      status: "exists",
      workspaceId: existing.id,
      workspaceName: existing.name,
      matchedBy: "template",
      guidance: oneSpacePerDomainGuidance({
        workspaceId: existing.id,
        name: existing.name,
      }),
    },
  };
}

/** Deterministic: owned first, then the OLDEST (the original domain space). */
function pickExisting(
  rows: Array<{ id: string; name: string; ownerId: string; createdAt: Date }>,
  userId: string
): { id: string; name: string } | undefined {
  const sorted = [...rows].sort((a, b) => {
    const ao = a.ownerId === userId ? 1 : 0;
    const bo = b.ownerId === userId ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return sorted[0];
}

/**
 * The idempotent create, for the doors that still drive layer 2 themselves
 * (W3/W4 retire them onto `applyTemplate`). A wrapper over the ONE layer-one
 * path (`template-apply/layer-one.ts`): the same lookup (`resolveTarget`) and
 * the same plan (`planTemplateApply`) as every other door — create, resume,
 * re-sync or skip, never the stamp (`pendingVersionStamp` is the finisher's).
 */
export type CreateWorkspaceFromDefinitionInput = LayerOneInput;
export type CreateWorkspaceFromDefinitionResult = LayerOneResult;

export function createWorkspaceFromDefinitionIdempotent(
  input: CreateWorkspaceFromDefinitionInput
): Promise<CreateWorkspaceFromDefinitionResult> {
  return applyLayerOne(input);
}

export { withWorkspaceProposalIdLock };

/**
 * Allow-list of agentTypes that may call the Hub Protocol REST workspace
 * creation endpoint. Other agentTypes get 403. Easy to extend by adding
 * a new entry below.
 */
export const WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST: ReadonlyArray<string> = [
  "eve",
  "coder",
];

export function isAgentTypeAllowedToCreateWorkspaces(
  agentType: string | null | undefined
): boolean {
  if (!agentType) return false;
  return WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST.includes(agentType);
}
