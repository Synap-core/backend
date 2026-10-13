/**
 * finishTemplateApply — the ONE door that writes a template apply's outcome
 * markers: the version stamp and the "active" state — through the ONE
 * template-state writer (`writeTemplateState`, @synap/database), under its
 * row lock.
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
   * An overlay pack this apply recorded in `installedPacks` without its
   * version (compose never records it): written here, on convergence only.
   */
  pendingPack?: { slug: string; version: string };
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
  const { workspaceId, userId, built, pendingVersionStamp, pendingPack, post } =
    input;
  // Nothing ran and nothing is claimed (e.g. a natural compose through a door
  // with no layer 2): there is no outcome to write — and clearing a record an
  // earlier, unfinished apply left would be a lie.
  if (post === null && !built && !pendingVersionStamp && !pendingPack)
    return { state: "converged", versionStamped: false };
  const { getDb, writeTemplateState, withPack } =
    await import("@synap/database");

  const converged =
    post === null
      ? !pendingVersionStamp && !pendingPack
      : postWorkspaceLayersConverged(post);
  const { proposals, failures } =
    !converged && post ? notLanded(post) : { proposals: [], failures: [] };
  const recordState: TemplateApplyRecord["state"] =
    post === null
      ? "layer-2-not-run"
      : failures.length > 0
        ? "partial"
        : "awaiting-approval";

  // Decided against the row the ONE writer locks (utils/template-state.ts):
  // a layer 2 that threw already marked the space failed — that record wins;
  // the resume path is what clears it.
  let failed = false;
  const written = await writeTemplateState(
    await getDb(),
    workspaceId,
    (current) => {
      if (current?.state === "failed") {
        failed = true;
        return null;
      }
      const now = new Date().toISOString();
      if (converged) {
        // A space another door is still building stays "building" unless
        // this apply built it.
        return {
          state: built || current?.state !== "building" ? "active" : "building",
          ...(pendingVersionStamp ? { version: pendingVersionStamp } : {}),
          ...(pendingPack
            ? { packs: withPack(current?.packs, pendingPack, now) }
            : {}),
        };
      }
      return {
        state: recordState,
        pendingVersion: pendingVersionStamp ?? pendingPack?.version ?? null,
        proposals: proposals.length > 0 ? proposals : null,
        failures: failures.length > 0 ? failures : null,
      };
    },
    { userId }
  );
  if (failed) return { state: "failed", versionStamped: false };
  if (converged)
    return {
      state: "converged",
      versionStamped: !!pendingVersionStamp && !!written,
    };
  const templateApply: TemplateApplyRecord = {
    state: recordState,
    version: pendingVersionStamp ?? pendingPack?.version ?? null,
    at: written?.at ?? new Date().toISOString(),
    ...(proposals.length > 0 ? { proposals } : {}),
    ...(failures.length > 0 ? { failures } : {}),
  };
  return { state: templateApply.state, versionStamped: false, templateApply };
}

/**
 * Re-open a space whose LAYER 2 failed (`failedInLayerTwo`) for a re-run of
 * layer 2. Layer 1 is built, so the space is what an unfinished apply is:
 * "layer-2-not-run" — a crash before the finisher runs still reads drifted,
 * never "failed" forever and never current. Leaving "failed" clears the
 * failure fields (the finisher refuses to overwrite "failed"); if layer 2
 * throws again, `applyPackagePostWorkspace` re-marks it.
 */
export async function reopenFailedLayerTwo(
  workspaceId: string,
  userId: string,
  version: string | undefined
): Promise<void> {
  const { getDb, writeTemplateState } = await import("@synap/database");
  await writeTemplateState(
    await getDb(),
    workspaceId,
    { state: "layer-2-not-run", pendingVersion: version ?? null },
    { userId }
  );
}
