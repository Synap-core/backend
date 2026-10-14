/**
 * Layer one of a template apply: find the space (`resolveTarget`), decide
 * (`planTemplateApply`), then build or re-sync its structure — profiles,
 * views, bento, links — under the per-(user, key) advisory lock. Never layer 2
 * and never the stamp: the version comes back as `pendingVersionStamp` for the
 * ONE finisher (`finishTemplateApply`), which stamps it only once layer 2
 * converged.
 *
 * `applyTemplate` runs it for every standalone (non-compose) apply, and
 * `createWorkspaceFromDefinitionIdempotent` is a wrapper over it for the doors
 * that still drive layer 2 themselves (W3/W4) — so every door decides
 * "create / resume / re-sync / skip" with the same lookup and the same plan.
 */
import { unfilteredAiFanoutError } from "@synap-core/types/automations";
import {
  createWorkspaceFromDefinition,
  reconcileWorkspaceFromDefinition,
  writeTemplateState,
  db,
  drizzleSql,
  workspaces,
  eq,
  type ReconcileReport,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import { getBoss } from "@synap/jobs";
import { createLogger } from "@synap-core/core";
import {
  resolveWorkspaceTemplate,
  type ResolvedWorkspaceTemplate,
} from "../capabilities/resolve-workspace-template.js";
import { reopenFailedLayerTwo } from "../template-apply-finisher.js";
import { planTemplateApply, type TemplateApplyAction } from "./plan.js";
import { resolveTarget } from "./resolve-target.js";

const logger = createLogger({ module: "template-apply/layer-one" });

export interface LayerOneInput {
  /** WorkspaceProposal-shaped definition (profiles, views, bento, etc.). */
  definition: WorkspaceDefinitionInput;
  /** Owning user — the space becomes member-owned by this user. */
  userId: string;
  /** Stable idempotency key (`provisioning_proposal_id`). */
  proposalId?: string;
  /** Name override (defaults to `definition.workspaceName`). */
  workspaceName?: string;
  /** Template provenance — stored in settings, not used for identity. */
  templateId?: string;
  templateName?: string;
  /** The catalog identity. */
  packageSlug?: string;
  /**
   * The caller's version. A create materializes it as given; a re-hit uses it
   * only as the FALLBACK when the catalog cache resolves no version (a private
   * template the pod's anonymous cache never sees).
   */
  packageVersion?: string;
  workspaceType?: "personal" | "agent" | "project" | "operational";
  linkedAgentId?: string;
  /** Audit field — who/what triggered this creation. */
  createdBy?: "user" | "provisioning" | "plugin";
}

export interface LayerOneResult {
  workspaceId: string;
  /** True iff a new space was provisioned (or a layer-1 build resumed). */
  created: boolean;
  /**
   *   - `"created"`    — built (or resumed) just now;
   *   - `"reconciled"` — the space existed and layer 1 was re-synced onto it;
   *   - `"unchanged"`  — the space existed and was current (or could not be
   *     compared): no write.
   */
  outcome: "created" | "reconciled" | "unchanged";
  /** What the plan decided. */
  action: TemplateApplyAction;
  /** Set on `"reconciled"`: the re-sync's report. */
  reconciled?: ReconcileReport;
  /**
   * `"reconciled"` only: the server-resolved template layer 1 ran against —
   * the source a caller syncing layer 2 must use, or it would skip what the
   * new version added. Undefined when layer 1 ran off the caller's definition.
   */
  packageDefinition?: ResolvedWorkspaceTemplate["packageDefinition"];
  /** The version layer 1 materialized / re-synced to — never stamped here. */
  pendingVersionStamp?: string;
}

/**
 * Run `fn` while holding a per-(userId, proposalId) advisory lock, so a hung
 * retry cannot race the original and double-create. Auto-released on session
 * close. No key → no lock (nothing to protect).
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
 * `settings || {proposalId}` — the key written into the stored blob in the
 * same statement, so a write never carries back a settings object read before
 * someone else (the reconcile) merged into it.
 */
function withProposalId(proposalId: string) {
  return drizzleSql`COALESCE(${workspaces.settings}, '{}'::jsonb) || jsonb_build_object('proposalId', ${proposalId}::text)`;
}

/** Key-only, atomic: never a read-then-write-back of the blob. Best-effort. */
async function stampKey(workspaceId: string, key: string): Promise<void> {
  try {
    await db
      .update(workspaces)
      .set({ provisioningProposalId: key, settings: withProposalId(key) })
      .where(eq(workspaces.id, workspaceId));
  } catch (err) {
    logger.warn(
      { err, workspaceId, key },
      "template apply: failed to stamp the idempotency key (non-fatal)"
    );
  }
}

/** The catalog's freshest copy of the template; a failed read = unknown. */
async function resolveFresh(
  packageSlug: string | undefined
): Promise<ResolvedWorkspaceTemplate | null> {
  if (!packageSlug) return null;
  try {
    return await resolveWorkspaceTemplate(packageSlug);
  } catch (err) {
    logger.warn(
      { err, packageSlug },
      "template apply: catalog template unresolvable — falling back to the caller's copy"
    );
    return null;
  }
}

export async function applyLayerOne(
  input: LayerOneInput
): Promise<LayerOneResult> {
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

  return withWorkspaceProposalIdLock(userId, proposalId, async () => {
    const target = await resolveTarget({
      userId,
      proposalId,
      packageSlug,
      workspaceName:
        workspaceName ??
        (definition as { workspaceName?: string }).workspaceName,
    });

    // ── No space: build one ───────────────────────────────────────────────
    if (!target.found) {
      // The caller's explicit version wins on a create; else the catalog's.
      const version =
        packageVersion || !packageSlug
          ? packageVersion
          : (await resolveFresh(packageSlug))?.version;
      const result = await createWorkspaceFromDefinition({
        definition,
        userId,
        packageSlug,
        packageVersion: version,
        templateId,
        templateName,
        workspaceName,
        workspaceType,
        linkedAgentId,
        createdBy,
      });
      if (proposalId) await stampKey(result.workspaceId, proposalId);
      try {
        await getBoss().send("workspace-init", {
          workspaceId: result.workspaceId,
          userId,
          packageSlug,
        });
      } catch (err) {
        logger.warn(
          { err, workspaceId: result.workspaceId },
          "Failed to enqueue workspace-init (non-fatal)"
        );
      }
      return {
        workspaceId: result.workspaceId,
        created: true,
        outcome: "created",
        action: { kind: "create" },
        ...(result.pendingVersionStamp
          ? { pendingVersionStamp: result.pendingVersionStamp }
          : {}),
      };
    }

    // ── A space holds it: plan against its state ──────────────────────────
    const { workspaceId } = target;
    const resolved = await resolveFresh(packageSlug);
    // Cache-first: a fresh catalog version always wins over the caller's.
    const version = resolved?.version ?? packageVersion;
    const action = planTemplateApply({
      target: { state: target.state },
      version,
    });
    // A legacy match adopts the key so the next call hits the fast path.
    if (target.via === "legacy" && packageSlug)
      await stampKey(workspaceId, packageSlug);
    logger.info(
      {
        userId,
        workspaceId,
        via: target.via,
        action: action.kind,
        packageSlug,
      },
      "template apply: existing space"
    );

    if (action.kind === "unchanged")
      return { workspaceId, created: false, outcome: "unchanged", action };

    if (action.kind === "resume-layer1") {
      const result = await createWorkspaceFromDefinition({
        definition,
        userId,
        packageSlug,
        packageVersion: packageVersion ?? resolved?.version,
        templateId,
        templateName,
        workspaceName,
        workspaceType,
        linkedAgentId,
        createdBy,
        resumeFrom: { workspaceId, completedSteps: action.completedSteps },
      });
      return {
        workspaceId: result.workspaceId,
        created: true,
        outcome: "created",
        action,
        ...(result.pendingVersionStamp
          ? { pendingVersionStamp: result.pendingVersionStamp }
          : {}),
      };
    }

    // A space exists, so the plan never answers "create" here.
    if (action.kind === "create")
      throw new Error(
        "template apply: plan answered create for an existing space"
      );

    // resync — additive, never destructive. Leave "failed" first (the
    // finisher never overwrites it); a layer 2 that throws again re-marks it.
    if (action.reopen) await reopenFailedLayerTwo(workspaceId, userId, version);
    let report: ReconcileReport;
    try {
      report = await reconcileWorkspaceFromDefinition({
        validateFlow: unfilteredAiFanoutError,
        workspaceId,
        userId,
        definition: (resolved?.workspaceDefinition ??
          definition) as WorkspaceDefinitionInput,
      });
    } catch (err) {
      // The space exists: record the layer-1 failure honestly (the next apply
      // plans a re-sync of it), then surface it.
      await writeTemplateState(
        db,
        workspaceId,
        {
          state: "failed",
          failedLayer: 1,
          failedStep: "reconcile",
          error: (err instanceof Error ? err.message : String(err)).slice(
            0,
            500
          ),
        },
        { userId }
      ).catch(() => undefined);
      throw err;
    }
    return {
      workspaceId,
      created: false,
      outcome: "reconciled",
      action,
      reconciled: report,
      ...(resolved?.packageDefinition
        ? { packageDefinition: resolved.packageDefinition }
        : {}),
      ...(version ? { pendingVersionStamp: version } : {}),
    };
  });
}
