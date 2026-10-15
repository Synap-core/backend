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
import { createLogger } from "@synap-core/core";
import { postWorkspaceLayersConverged } from "./capabilities/install-layers.js";
import {
  declaredLayerTwoKinds,
  type LayerTwoKey,
} from "./template-apply/layer-two-keys.js";

export type TemplateApplyRecord = NonNullable<
  WorkspaceSettings["templateApply"]
>;

const logger = createLogger({ module: "template-apply-finisher" });

/**
 * The profile slugs a template definition declares — what a pending template
 * data change is matched on. The ONE extraction (apply, dependency, boot).
 */
export function templateProfileSlugs(definition: object | undefined): string[] {
  const profiles = (definition as { profiles?: unknown } | undefined)?.profiles;
  return (Array.isArray(profiles) ? profiles : [])
    .map((p) => (p as { slug?: unknown } | null)?.slug)
    .filter((slug): slug is string => typeof slug === "string" && !!slug);
}

/** Why a stamp is held: the pending opKeys, or the list could not be read. */
export interface DataChangeHold {
  opKeys: string[];
  unreadable: boolean;
}

/**
 * DATA CHANGES (TEMPLATE-LIFECYCLE Contract C), decided HERE for every stamp:
 * a template whose profiles a pending, consentable data change still touches
 * does not earn its version — the stamp would claim a convergence the data
 * has not made. Health keeps the space drifted and names the change
 * (`settings.template.heldForDataChanges`); `synap templates update` is where
 * a person sees it and agrees. A failed read holds too — never guess "none".
 * `null` = nothing holds the stamp.
 */
export async function dataChangeHold(
  definition: object | undefined
): Promise<DataChangeHold | null> {
  const { sql, pendingTemplateDataChanges, holdsTemplateStamp } =
    await import("@synap/database");
  try {
    const pending = await pendingTemplateDataChanges(
      sql,
      templateProfileSlugs(definition)
    );
    if (!holdsTemplateStamp(pending)) return null;
    return {
      opKeys: pending.filter((c) => !c.destructive).map((c) => c.opKey),
      unreadable: false,
    };
  } catch (err) {
    logger.warn(
      { err },
      "template apply: pending data changes unreadable — the version stamp is held"
    );
    return { opKeys: [], unreadable: true };
  }
}

/** The record of a hold (`null` patch = cleared, once a stamp lands). */
function heldPatch(hold: DataChangeHold | null) {
  return {
    heldForDataChanges: hold ? hold.opKeys : null,
    heldForDataChangesUnreadable: hold?.unreadable ? (true as const) : null,
  };
}

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
  /**
   * The template definition this apply converged the space to. An UPDATE's
   * stamp (a re-hit, not a build: a first install converts nothing) and an
   * already-recorded pack's version are HELD while a consentable data change
   * touches its profiles (`dataChangeHold`); the hold is recorded on the
   * space. Omitted = no data-change check (nothing to match on).
   */
  definition?: object;
}

export interface FinishTemplateApplyResult {
  state: "converged" | TemplateApplyRecord["state"] | "failed";
  versionStamped: boolean;
  /** Present when the apply did not converge — the record written. */
  templateApply?: TemplateApplyRecord;
  /** Layers converged, but the stamp is held for these data changes. */
  held?: DataChangeHold;
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
  // Read BEFORE the row lock (a dry run per pending op); applied under it.
  const hold =
    converged &&
    input.definition &&
    ((pendingVersionStamp && !built) || pendingPack)
      ? await dataChangeHold(input.definition)
      : null;
  let held: DataChangeHold | undefined;
  let versionWasHeld = false;
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
      // The hold covers the space's own stamp on an update, and a pack's
      // version only when the pack is already recorded (its update — a
      // pack's first install converts nothing).
      const versionHeld = !!hold && !!pendingVersionStamp && !built;
      const packHeld =
        !!hold &&
        !!pendingPack &&
        !!current?.packs?.some((p) => p.slug === pendingPack.slug);
      const pack =
        pendingPack && packHeld
          ? { slug: pendingPack.slug, version: undefined }
          : pendingPack;
      if (versionHeld || packHeld) held = hold!;
      versionWasHeld = versionHeld;
      // A new hold replaces the record; the space's own stamp landing clears
      // it (a pack converging says nothing about the space's own version).
      const holdRecord =
        versionHeld || packHeld
          ? heldPatch(hold)
          : pendingVersionStamp
            ? heldPatch(null)
            : {};
      if (current?.state === "failed") {
        failed = true;
        // The space's own failure stands — only its own update clears it. An
        // overlay pack layered onto it whose layer 2 just converged is still
        // recorded: that is the pack's convergence, not the space's.
        return converged && pack
          ? {
              packs: withPack(current.packs, pack, now),
              ...(packHeld ? heldPatch(hold) : {}),
            }
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
          ...(pendingVersionStamp && !versionHeld
            ? { version: pendingVersionStamp }
            : {}),
          ...(pack ? { packs: withPack(current?.packs, pack, now) } : {}),
          ...holdRecord,
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
      versionStamped: !!pendingVersionStamp && !!written && !versionWasHeld,
      ...(held ? { held } : {}),
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
 * Re-open a space whose last apply did not end — LAYER 2 failed
 * (`isFailedInLayerTwo`), a re-sync failed, or a build was left "building" —
 * for a re-sync and a re-run of layer 2. Layer 1 exists, so the space is what an unfinished apply is:
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
 * What a boot pass CONVERGED for one template (a space's own, or an overlay
 * pack): the version it resolved, the package it resolved (to read which
 * layer-2 kinds the template declares) and the layer-2 kinds the pass itself
 * converged. The stamp is earned only when the second set covers the first.
 */
export interface BootConvergedTemplate {
  version: string;
  /** The resolved package definition (any object shape — only its keys are read). */
  templatePackage: object;
  converged: readonly LayerTwoKey[];
}

/**
 * The layer-2 kinds a template declares that a boot pass did NOT converge
 * (empty = the pass covered the whole template, and may stamp it).
 */
export function bootUncoveredLayerTwo(t: BootConvergedTemplate): LayerTwoKey[] {
  return declaredLayerTwoKinds(t.templatePackage).filter(
    (k) => !t.converged.includes(k)
  );
}

/**
 * The BOOT channel of the one finisher (D19 / D20). A boot pass converges a
 * space's own template (layer 1 + playbooks + rules, every boot) and its
 * overlay packs (layer 1 + playbooks), unattended — it never runs the rest of
 * layer 2 (capabilities, automations, loops, cells, action placements,
 * skills): that would widen what happens without a person (decision 4), and
 * cost a Control Plane round-trip per space per boot. The version is the
 * CP's WHOLE-template hash, so a boot pass may stamp it only when what it
 * converged covers every layer-2 kind the template declares
 * (`bootUncoveredLayerTwo` empty — backend-rules: a marker asserts only what
 * its comparator checked). Otherwise the stamp waits: health keeps the space
 * drifted, and `synap templates update` runs the full apply and stamps.
 *
 *   - `template`: the space's own template. Written also only when the last
 *     apply on the space is finished and no build is in flight;
 *   - `packs`: overlay packs, each under the same coverage rule.
 * The state is never changed here: a boot pass builds nothing and fails
 * nothing it would have to record.
 */
export async function finishBootConvergence(input: {
  workspaceId: string;
  userId: string;
  template?: BootConvergedTemplate;
  packs?: Array<BootConvergedTemplate & { slug: string }>;
}): Promise<{
  versionStamped: boolean;
  packsRecorded: number;
  /** The template's layer-2 kinds this pass did not converge (no stamp). */
  uncovered: LayerTwoKey[];
  /** The template's stamp is held for these data changes (Contract C). */
  held?: DataChangeHold;
  /** Packs whose version is held for a data change. */
  packsHeld: number;
}> {
  const { workspaceId, userId, template } = input;
  const uncovered = template ? bootUncoveredLayerTwo(template) : [];
  const covered = uncovered.length === 0 ? template : undefined;
  // Contract C, the same hold every stamp passes (`dataChangeHold`): a boot
  // pass is always an update of an existing space.
  const held = covered ? await dataChangeHold(covered.templatePackage) : null;
  const version = held ? undefined : covered?.version;
  const packs: Array<{ slug: string; version: string }> = [];
  const packHolds: DataChangeHold[] = [];
  for (const p of input.packs ?? []) {
    if (bootUncoveredLayerTwo(p).length > 0) continue;
    const packHold = await dataChangeHold(p.templatePackage);
    if (packHold) packHolds.push(packHold);
    else packs.push({ slug: p.slug, version: p.version });
  }
  const holds = [...(held ? [held] : []), ...packHolds];
  const hold: DataChangeHold | null =
    holds.length > 0
      ? {
          opKeys: [...new Set(holds.flatMap((h) => h.opKeys))],
          unreadable: holds.some((h) => h.unreadable),
        }
      : null;
  const done = {
    uncovered,
    packsHeld: packHolds.length,
    ...(held ? { held } : {}),
  };
  if (!version && packs.length === 0 && !hold)
    return { versionStamped: false, packsRecorded: 0, ...done };
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
      if (!stamp && packs.length === 0 && !hold) return null;
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
        // A new hold replaces the record; the own stamp landing clears it.
        ...(hold ? heldPatch(hold) : stamp ? heldPatch(null) : {}),
      };
    },
    { userId }
  );
  return { versionStamped, packsRecorded: packs.length, ...done };
}
