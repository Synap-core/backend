/**
 * finishTemplateApply — the ONE door that writes a template apply's outcome
 * markers: `settings.packageVersion` (the version stamp) and
 * `provisioningStatus: "active"`.
 *
 * WHY ONE DOOR. The stamp says "this space is at template version X", and the
 * template is layer 1 (profiles / views / bento) AND layer 2 (capabilities,
 * playbooks, automations, loops, cells, action placements, rules, skills).
 * Every door that wrote the stamp itself wrote it after layer 1, before layer 2
 * ran — so a layer 2 that failed, or only filed proposals, left a stamp that
 * claimed a convergence that never happened. Template health then read the
 * space as current, `synap templates update` skipped it, and the missing
 * playbook / button never arrived (founder pod, 2026-10-12, CRM).
 *
 * So the create/resume core (`createWorkspaceFromDefinition`) and the re-hit
 * reconcile (`reconcileWorkspaceIfStale`) never stamp: they hand the version
 * back as `pendingVersionStamp`, and every door hands it here with its layer-2
 * result. Marker invariant (backend-rules): a stamp only asserts what landed.
 *
 *   converged   → stamp the version, mark the space "active", clear the record
 *   not landed  → no stamp; record WHY in `settings.templateApply`
 *                 (awaiting-approval · partial · layer-2-not-run). Health reads
 *                 that as drifted, so the next update finishes the job.
 *
 * "active" means "built, nothing crashed" — a space whose layer 2 only proposed
 * is usable, and leaving it "pending" would read as an in-flight build (the
 * tRPC re-hit skips reconcile on a non-active space). The STAMP is what means
 * "converged". A layer 2 that threw already marked the space "failed"
 * (`applyPackagePostWorkspace`); this door never overwrites that.
 */

import type { WorkspaceSettings } from "@synap/database";
import { postWorkspaceLayersConverged } from "./capabilities/install-layers.js";
import { stampWorkspacePackageVersion } from "./workspace-creation-service.js";

export type TemplateApplyRecord = NonNullable<
  WorkspaceSettings["templateApply"]
>;

export interface FinishTemplateApplyInput {
  workspaceId: string;
  userId: string;
  /**
   * True when THIS apply ran the create/resume core to completion — the space
   * is "pending" and ours to mark "active". False for a re-hit of an existing
   * space (its status is not this apply's to change) and for a compose.
   */
  built: boolean;
  /** The version layer 1 materialized / reconciled to — never stamped by it. */
  pendingVersionStamp?: string;
  /**
   * The `applyPackagePostWorkspace` result bag. `{}` when the template has no
   * living layers (nothing to land). `null` when this door does not run layer 2
   * at all — then a pending version is never earned here.
   */
  post: Record<string, unknown> | null;
}

export interface FinishTemplateApplyResult {
  state: "converged" | TemplateApplyRecord["state"] | "failed";
  versionStamped: boolean;
  /** Present when the apply did not converge — the record written. */
  templateApply?: TemplateApplyRecord;
}

/** What did not land, read from the layer-2 bag: proposal ids and error lines. */
function notLanded(bag: Record<string, unknown>): {
  proposals: string[];
  failures: string[];
} {
  const proposals: string[] = [];
  const failures: string[] = [];
  for (const [key, value] of Object.entries(bag)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      if (it.status === "error") {
        const name =
          typeof it.name === "string"
            ? it.name
            : typeof it.key === "string"
              ? it.key
              : "";
        failures.push(name ? `${key}:${name}` : key);
      }
      if (it.status === "proposed") {
        if (typeof it.proposalId === "string") proposals.push(it.proposalId);
        for (const p of Array.isArray(it.proposals) ? it.proposals : []) {
          const id =
            typeof p === "string"
              ? p
              : (p as { proposalId?: unknown } | null)?.proposalId;
          if (typeof id === "string") proposals.push(id);
        }
        for (const d of Array.isArray(it.deferred) ? it.deferred : []) {
          const id = (d as { proposalId?: unknown } | null)?.proposalId;
          if (typeof id === "string") proposals.push(id);
        }
      }
    }
  }
  return { proposals: [...new Set(proposals)], failures };
}

export async function finishTemplateApply(
  input: FinishTemplateApplyInput
): Promise<FinishTemplateApplyResult> {
  const { workspaceId, userId, built, pendingVersionStamp, post } = input;
  const { db, workspaces, eq, getDb, eventRepository, WorkspaceRepository } =
    await import("@synap/database");
  const [row] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const status = (row?.settings as WorkspaceSettings | null)
    ?.provisioningStatus;
  // A layer 2 that threw already marked the space failed — that record wins;
  // the resume path (`resumeIfFailed`) is what clears it.
  if (status === "failed") return { state: "failed", versionStamped: false };

  const repo = new WorkspaceRepository(await getDb(), eventRepository);
  const activate = built ? { provisioningStatus: "active" as const } : {};

  const converged =
    post === null ? !pendingVersionStamp : postWorkspaceLayersConverged(post);
  if (converged) {
    if (pendingVersionStamp) {
      await stampWorkspacePackageVersion(workspaceId, pendingVersionStamp);
    }
    await repo.mergeSettings(
      workspaceId,
      { ...activate, templateApply: null },
      userId
    );
    return { state: "converged", versionStamped: !!pendingVersionStamp };
  }

  const { proposals, failures } = post ? notLanded(post) : notLanded({});
  const templateApply: TemplateApplyRecord = {
    state:
      post === null
        ? "layer-2-not-run"
        : failures.length > 0
          ? "partial"
          : "awaiting-approval",
    version: pendingVersionStamp ?? null,
    at: new Date().toISOString(),
    ...(proposals.length > 0 ? { proposals } : {}),
    ...(failures.length > 0 ? { failures } : {}),
  };
  await repo.mergeSettings(workspaceId, { ...activate, templateApply }, userId);
  return { state: templateApply.state, versionStamped: false, templateApply };
}
