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
 * So the create/resume core (`createWorkspaceFromDefinition`) and the re-sync
 * (`reconcileWorkspaceFromDefinition`, through layer one) never stamp: they hand the version
 * back as `pendingVersionStamp`, and every door hands it here with its layer-2
 * result. Marker invariant (backend-rules): a stamp only asserts what landed.
 *
 *   converged   → stamp the version, mark the space "active", clear the record
 *   not landed  → no stamp; record WHY in `settings.template`
 *                 (awaiting-approval · partial · layer-2-not-run). Health reads
 *                 that as drifted, so the next update finishes the job.
 *   layer 2 threw → no stamp; record `failed` (layer 2) — the caller passes
 *                 `layerTwoFailed`, never an empty result bag.
 *
 * "active" means "built, nothing crashed" — a space whose layer 2 only proposed
 * is usable, and leaving it "building" would read as an in-flight build. The
 * STAMP is what means "converged". A space already "failed" keeps that record:
 * only a re-sync of it (which reopens it first) clears it.
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
  /**
   * Layer 2 threw (or its body could not be prepared). The finisher RECORDS
   * it — `failed`, layer 2 — under its row lock: never a stamp, never
   * "active", whatever an earlier best-effort record did or did not land.
   * `post` is ignored then: a failure is never read from a result bag.
   */
  layerTwoFailed?: { error: unknown };
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
  if (input.layerTwoFailed) {
    const { getDb, writeTemplateState, LAYER_TWO_FAILED_STEP } =
      await import("@synap/database");
    const cause = input.layerTwoFailed.error;
    await writeTemplateState(
      await getDb(),
      workspaceId,
      {
        state: "failed",
        failedLayer: 2,
        failedStep: LAYER_TWO_FAILED_STEP,
        error: (cause instanceof Error ? cause.message : String(cause)).slice(
          0,
          500
        ),
      },
      { userId }
    );
    return { state: "failed", versionStamped: false };
  }
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
  // a space recorded "failed" keeps that record — only a re-sync, which
  // reopens it before layer 2 runs, clears it.
  let failed = false;
  const written = await writeTemplateState(
    await getDb(),
    workspaceId,
    (current) => {
      const now = new Date().toISOString();
      if (current?.state === "failed") {
        failed = true;
        // The space's own failure stands — only its own update clears it. An
        // overlay pack layered onto it whose layer 2 just converged is still
        // recorded: that is the pack's convergence, not the space's.
        return converged && pendingPack
          ? { packs: withPack(current.packs, pendingPack, now) }
          : null;
      }
      if (converged) {
        // A space another door is still building stays "building" unless
        // this apply built it.
        const active = built || current?.state !== "building";
        return {
          state: active ? "active" : "building",
          // A converged space has no build to resume: its create's ledger
          // goes (a later failed re-sync must never read as "resume").
          ...(active ? { completedSteps: null } : {}),
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
 * Re-open a space whose LAYER 2 failed (`isFailedInLayerTwo`) for a re-run of
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

/**
 * The BOOT channel of the one finisher (D19 / D20): the boot pass converges a
 * space's own template (layer 1 + playbooks + rules, every boot) and its
 * overlay packs, and hands here only what it CHECKED converged:
 *   - `version`: the space's template version. Written only when the last
 *     apply on the space is finished and no build is in flight — this pass did not run every layer 2
 *     kind (capabilities, automations, cells, skills…), so it cannot finish an
 *     apply that is awaiting approval, partial, never ran layer 2, or failed;
 *     the update door does, and its finisher stamps;
 *   - `packs`: overlay packs whose layer 1 + playbooks converged.
 * The state is never changed here: a boot pass builds nothing and fails
 * nothing it would have to record.
 */
export async function finishBootConvergence(input: {
  workspaceId: string;
  userId: string;
  version?: string;
  packs?: Array<{ slug: string; version: string }>;
}): Promise<{ versionStamped: boolean; packsRecorded: number }> {
  const { workspaceId, userId, version, packs = [] } = input;
  if (!version && packs.length === 0)
    return { versionStamped: false, packsRecorded: 0 };
  const { getDb, writeTemplateState, withPack, isTemplateApplyUnfinished } =
    await import("@synap/database");
  let versionStamped = false;
  await writeTemplateState(
    await getDb(),
    workspaceId,
    (current) => {
      const now = new Date().toISOString();
      // "failed" is unfinished too; "building" is another door's build.
      const stamp =
        !!version &&
        current?.state !== "building" &&
        !isTemplateApplyUnfinished(current);
      if (!stamp && packs.length === 0) return null;
      versionStamped = stamp;
      return {
        ...(stamp ? { version } : {}),
        ...(packs.length > 0
          ? {
              packs: packs.reduce(
                (acc, pack) => withPack(acc, pack, now),
                current?.packs
              ),
            }
          : {}),
      };
    },
    { userId }
  );
  return { versionStamped, packsRecorded: packs.length };
}
