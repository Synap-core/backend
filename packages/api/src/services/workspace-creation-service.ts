/**
 * Workspace Creation Service
 *
 * Shared idempotent wrapper around `createWorkspaceFromDefinition`. Used by
 * both the tRPC `workspaces.createFromDefinition` mutation and the Hub
 * Protocol REST `/workspaces/from-definition` endpoint so external callers
 * (Eve, Coder) get the same idempotency guarantees as the in-app path.
 *
 * Two idempotency keys are supported:
 *   1. `packageSlug` — historic key used by the tRPC path (see workspaces router).
 *   2. `proposalId`  — caller-supplied stable key used by Hub REST (Eve / Coder
 *      generate this from a template id like "builder-workspace-v1").
 *
 * If a workspace already exists for the user with the given key, return it
 * with `created: false`. Otherwise create a new workspace and return
 * `created: true`.
 */
import {
  createWorkspaceFromDefinition,
  reconcileWorkspaceFromDefinition,
  db,
  drizzleSql,
  workspaceMembers,
  workspaces,
  and,
  eq,
  type ReconcileReport,
  type WorkspaceDefinitionInput,
  type WorkspaceSettings,
} from "@synap/database";
import { getBoss } from "@synap/jobs";
import { createLogger } from "@synap-core/core";
import { resolveWorkspaceTemplate } from "./capabilities/resolve-workspace-template.js";

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
 * (additive, non-destructive — never deletes/mutates existing data) +
 * re-stamp `settings.packageVersion` so the NEXT hit short-circuits clean.
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
}): Promise<ReconcileIfStaleResult> {
  const { workspaceId, packageSlug, currentSettings, userId } = opts;
  if (!packageSlug) return { reconciled: false, checked: false };

  try {
    const resolved = await resolveWorkspaceTemplate(packageSlug);
    if (!resolved?.version) return { reconciled: false, checked: false };

    if (resolved.version === currentSettings?.packageVersion) {
      return { reconciled: false, checked: true, version: resolved.version };
    }

    const report = await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId,
      definition:
        resolved.workspaceDefinition as unknown as WorkspaceDefinitionInput,
    });

    // Stamp the new version so the NEXT idempotent hit short-circuits as
    // up to date instead of re-reconciling every time.
    try {
      await db
        .update(workspaces)
        .set({
          settings: {
            ...(currentSettings ?? {}),
            packageVersion: resolved.version,
          } satisfies WorkspaceSettings,
        })
        .where(eq(workspaces.id, workspaceId));
    } catch (err) {
      logger.warn(
        { err, workspaceId },
        "reconcileWorkspaceIfStale: failed to stamp reconciled packageVersion (non-fatal)"
      );
    }

    return {
      reconciled: true,
      checked: true,
      report,
      version: resolved.version,
    };
  } catch (err) {
    logger.warn(
      { err, workspaceId, packageSlug },
      "reconcileWorkspaceIfStale: version check failed (non-fatal)"
    );
    return { reconciled: false, checked: false };
  }
}

export interface CreateWorkspaceFromDefinitionInput {
  /** WorkspaceProposal-shaped definition (profiles, views, bento, etc.). */
  definition: WorkspaceDefinitionInput;
  /** Owning user — workspace becomes member-owned by this user. */
  userId: string;
  /**
   * Stable caller-supplied idempotency key. If present and a workspace with
   * this `proposalId` already exists for the user → return it untouched.
   */
  proposalId?: string;
  /** Optional human-friendly workspace name override (defaults to definition.workspaceName). */
  workspaceName?: string;
  /** Optional template provenance — stored in settings, not used for idempotency. */
  templateId?: string;
  templateName?: string;
  /** Optional CP package slug. Tracked separately from proposalId for the in-app path. */
  packageSlug?: string;
  packageVersion?: string;
  workspaceType?: "personal" | "agent" | "project" | "operational";
  linkedAgentId?: string;
  /** Audit field — who/what triggered this creation. */
  createdBy?: "user" | "provisioning" | "plugin";
}

export interface CreateWorkspaceFromDefinitionResult {
  workspaceId: string;
  /** True iff a new workspace was provisioned. False on idempotent re-hit. */
  created: boolean;
  /**
   * Set on an idempotent re-hit (`created:false`) that was additively synced
   * to a newer template via `reconcileWorkspaceIfStale` — W2b's version-aware
   * re-install, shared by BOTH doors (see that function's doc).
   */
  reconciled?: ReconcileReport;
  /**
   * Explicit discriminator so a caller never has to infer intent from
   * `created`/`reconciled` alone — the E4 fix: `created:true` used to be
   * returned for BOTH a genuine new workspace AND (before this field existed)
   * could be misread as covering a reused-but-stale one, since the two were
   * distinguishable only by also checking `reconciled`.
   *   - `"created"`    — a new workspace was materialized just now.
   *   - `"reconciled"` — the workspace already existed and drifted from the
   *     resolved template, so `reconcileWorkspaceIfStale` wrote additive
   *     changes onto it (see `reconciled` for the report).
   *   - `"unchanged"`  — the workspace already existed and was already
   *     current (or no version comparison was possible) — no write happened.
   */
  outcome: "created" | "reconciled" | "unchanged";
}

/**
 * Run `fn` while holding a per-(userId, proposalId) advisory lock. Used by
 * both the Hub REST and tRPC `createFromDefinition` paths to serialise
 * concurrent calls with the same idempotency key. The lock auto-releases on
 * session close, so a crashed handler can't deadlock future calls.
 *
 * If `proposalId` is missing, `fn` runs without locking — no idempotency to
 * protect.
 */
export async function withWorkspaceProposalIdLock<T>(
  userId: string,
  proposalId: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!proposalId) return fn();
  await db.execute(
    drizzleSql`SELECT pg_advisory_lock(
      hashtext('synap:workspace-from-definition:' || ${userId}),
      hashtext(${proposalId})
    )`
  );
  try {
    return await fn();
  } finally {
    await db.execute(
      drizzleSql`SELECT pg_advisory_unlock(
        hashtext('synap:workspace-from-definition:' || ${userId}),
        hashtext(${proposalId})
      )`
    );
  }
}

/**
 * Idempotently create a workspace from a definition.
 *
 * Idempotency check (in order):
 *   1. If `proposalId` is provided, look for an existing workspace whose
 *      settings.proposalId matches AND the caller is a member.
 *
 * On hit → return existing { workspaceId, created: false }.
 * On miss → run `createWorkspaceFromDefinition` and stamp `proposalId` into
 * settings so subsequent calls hit.
 */
export async function createWorkspaceFromDefinitionIdempotent(
  input: CreateWorkspaceFromDefinitionInput
): Promise<CreateWorkspaceFromDefinitionResult> {
  const {
    definition,
    userId,
    proposalId,
    workspaceName,
    templateId,
    templateName,
    packageSlug,
    packageVersion,
    workspaceType,
    linkedAgentId,
    createdBy = "user",
  } = input;

  // Serialise concurrent calls with the same (userId, proposalId) so a hung
  // retry can't race the original and double-create. No-op when proposalId
  // is missing.
  return withWorkspaceProposalIdLock(userId, proposalId, async () => {
    // ── 1. Idempotency by proposalId ────────────────────────────────────────────
    if (proposalId) {
      const existingMembership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.userId, userId),
          // Match the JSONB proposalId via SQL — avoids loading every workspace
          // row for the user. The composite (workspace_id, proposalId) check
          // happens server-side; we then verify membership via the join.
          drizzleSql`EXISTS (
          SELECT 1 FROM workspaces w
          WHERE w.id = ${workspaceMembers.workspaceId}
            AND w.provisioning_proposal_id = ${proposalId}
        )`
        ),
        with: { workspace: true },
      });
      if (existingMembership?.workspace) {
        const ws = existingMembership.workspace;
        const currentSettings = (ws.settings ??
          null) as WorkspaceSettings | null;
        // W2b: bring an already-present workspace up to the FRESHEST template
        // (cache-first, hash-compared) instead of silently no-op-ing — this is
        // the Hub-door gap the tRPC door already had a (now-shared) fix for.
        const { reconciled, report } = await reconcileWorkspaceIfStale({
          workspaceId: ws.id,
          packageSlug,
          currentSettings,
          userId,
        });
        logger.info(
          {
            userId,
            proposalId,
            workspaceId: ws.id,
            reconciled,
          },
          "createFromDefinition (Hub): returning existing workspace by proposalId"
        );
        return {
          workspaceId: ws.id,
          created: false,
          outcome: reconciled ? "reconciled" : "unchanged",
          ...(reconciled && report ? { reconciled: report } : {}),
        };
      }
    }

    // ── 2. Create new workspace ────────────────────────────────────────────────
    // Resolve the version to stamp: prefer an explicit caller-supplied
    // `packageVersion`; otherwise, when `packageSlug` is known, resolve the
    // CP's freshest hash via `resolveWorkspaceTemplate` (W2a) so a Hub-door
    // create records the same hash the tRPC door's `input.packageVersion`
    // passthrough already recorded — closing the "only tRPC stamps it" gap.
    let versionToStamp = packageVersion;
    if (!versionToStamp && packageSlug) {
      try {
        const resolved = await resolveWorkspaceTemplate(packageSlug);
        versionToStamp = resolved?.version;
      } catch {
        // Best-effort — a failed resolve here must never block workspace creation.
      }
    }
    const result = await createWorkspaceFromDefinition({
      definition,
      userId,
      packageSlug,
      packageVersion: versionToStamp,
      templateId,
      templateName,
      workspaceName,
      workspaceType,
      linkedAgentId,
      createdBy,
    });

    // ── 3. Persist proposalId into settings so future calls are idempotent ─────
    // Done as a follow-up merge instead of being passed through
    // CreateFromDefinitionOptions to avoid widening that public type for a
    // Hub-REST-only concern. The merge is best-effort: a transient failure
    // here just means the next call will create a duplicate (acceptable for
    // a setup endpoint).
    if (proposalId) {
      try {
        const ws = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, result.workspaceId),
          columns: { settings: true },
        });
        const existingSettings = (ws?.settings ?? {}) as WorkspaceSettings;
        await db
          .update(workspaces)
          .set({
            provisioningProposalId: proposalId,
            settings: {
              ...existingSettings,
              proposalId,
            } satisfies WorkspaceSettings,
          })
          .where(eq(workspaces.id, result.workspaceId));
      } catch (err) {
        logger.warn(
          { err, workspaceId: result.workspaceId, proposalId },
          "Failed to stamp proposalId into workspace settings (non-fatal)"
        );
      }
    }

    // ── 4. Enqueue workspace-init for default whiteboard/commands ──────────────
    // Mirrors the tRPC path so the Hub-created workspace has the same defaults.
    try {
      const boss = getBoss();
      await boss.send("workspace-init", {
        workspaceId: result.workspaceId,
        userId,
        packageSlug,
      });
    } catch (err) {
      logger.warn(
        { err, workspaceId: result.workspaceId },
        "Failed to enqueue workspace-init from Hub path (non-fatal)"
      );
    }

    return {
      workspaceId: result.workspaceId,
      created: true,
      outcome: "created",
    };
  });
}

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
