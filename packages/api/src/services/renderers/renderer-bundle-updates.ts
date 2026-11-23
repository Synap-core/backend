/**
 * Renderer bundle UPDATES (plan ad703ccd L2; founder decisions D1, D2, D7,
 * D8 of 22 Nov 2026). The bundle is one more whole-package kind of the pod's
 * package updates (`services/package-updates/`): the standing reads what this
 * module records, the apply and Undo doors call it. No second updater.
 *
 * THE PASS (`syncRendererBundleUpdates`) runs after each official catalog
 * sync (every 10 minutes, `registerOfficialCatalogSyncedHandler`, apps/api):
 *
 *   1. another bundle holds the pod's host-module set → nothing to do;
 *   2. read the control plane's METADATA of the bundle (`?meta=1`: version,
 *      digest, publish date, retired; no definition, no delivery row). A
 *      refusal (no plan, not enrolled, not live…) is recorded with the pod's
 *      machine reason for pod admin's Renderers card, and the pass stops;
 *   3. no bundle installed → install it now (D2: a plan pod's first sync; the
 *      read in 2 proved a plan covers the pod). No wait: there is nothing on
 *      the pod to protect;
 *   4. the installed version is the newest → nothing waits;
 *   5. otherwise the update WAITS FOR THE OWNER when the owner stopped
 *      updates, when this version is held (it needs what the pod lacks, or the
 *      owner undid it), or when automatic updates are off (the pod's ONE
 *      setting `pod_settings.settings.updates`, never a second switch); else it
 *      applies on its own once the SOAK passed (D1: 1 h on `fast`, 24 h on
 *      `stable`, from the publish date), at once when Synap retired the
 *      installed version (D8).
 *
 * An applied update writes a receipt (`installOfficialRendererBundle`); Undo
 * (`undoRendererBundleUpdate`) re-installs the version kept on the pod after
 * re-checking it against the digest recorded at its install (D7), and holds
 * the undone version so it does not come back by itself.
 */

import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { getDb, and, eq, getActingAgentUserId } from "@synap/database";
import {
  rendererBundles,
  rendererBundleUpdates,
  rendererBundleVersions,
  rendererHostModules,
  type RendererBundleUpdatesRow,
} from "@synap/database/schema";
import { OFFICIAL_SOURCE_ID } from "@synap-core/types/marketplace-source";
import { RENDERER_BUNDLE_KIND } from "@synap-core/types/renderables";
import {
  RENDERER_BUNDLE_SOAK_MS,
  type PackageUpdateApplyResult,
  type PackageUpdateReceipt,
  type RendererBundleHoldReason,
  type RendererBundleUpdateState,
} from "@synap-core/types/package-updates";

import type { Context } from "../../types/context.js";
import { resolvePodOwnerUserId } from "../capabilities/pod-owner.js";
import { recordPackageUpdateUndone } from "../package-updates/receipts.js";
import { packageUpdateRefusal } from "../package-updates/refusals.js";
import {
  installRendererBundle,
  rendererBundleContentHash,
  RENDERER_BUNDLE_REQUIRES_UNMET,
} from "./install-renderer-bundle.js";
import {
  fetchOfficialRendererBundleMeta,
  installOfficialRendererBundle,
  SYNAP_RENDERERS_SLUG,
} from "./official-renderer-bundle.js";

const logger = createLogger({ module: "renderer-bundle-updates" });

/** The pod's update setting, as the after-sync handler resolved it. */
export interface RendererUpdateSettings {
  auto: boolean;
  channel: keyof typeof RENDERER_BUNDLE_SOAK_MS;
}

/** What one pass did (logged; the tests read it). */
export type RendererBundleSyncOutcome =
  | { kind: "other-bundle"; holder: string }
  | { kind: "refused"; reasonCode: string }
  | { kind: "installed"; version: string }
  | { kind: "current"; version: string }
  | { kind: "stopped"; latest: string }
  | { kind: "held"; latest: string; reason: RendererBundleHoldReason }
  | { kind: "manual"; latest: string }
  | { kind: "waiting"; latest: string; applyAfter: Date }
  | { kind: "updated"; from: string; to: string };

/**
 * When this process started. A pod update restarts it, so a bundle held for
 * needing what the pod lacked is tried again once by the new process: the
 * pod's contract may have caught up (no 3 MB fetch every 10 minutes).
 */
const PROCESS_STARTED_AT = new Date();

/** The hold that keeps `latest` waiting for the owner, if any. */
function activeHold(
  state: RendererBundleUpdatesRow | null,
  latest: string
): RendererBundleHoldReason | null {
  if (!state?.holdReason || state.holdVersion !== latest) return null;
  const reason = state.holdReason as RendererBundleHoldReason;
  if (
    reason === "requires" &&
    state.heldAt &&
    state.heldAt.getTime() < PROCESS_STARTED_AT.getTime()
  ) {
    return null;
  }
  return reason;
}

/** The machine reason of a refusal, or `failed` for an untyped error. */
function reasonCodeOf(err: unknown): string {
  const cause = (err as { cause?: { reasonCode?: unknown } } | null)?.cause;
  return typeof cause?.reasonCode === "string" ? cause.reasonCode : "failed";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readRow(slug: string): Promise<RendererBundleUpdatesRow | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(rendererBundleUpdates)
    .where(eq(rendererBundleUpdates.slug, slug))
    .limit(1);
  return row ?? null;
}

type StatePatch = Partial<
  Omit<typeof rendererBundleUpdates.$inferInsert, "slug" | "updatedAt">
>;

/** Write part of a bundle's update state (the row is created on first write). */
async function patchState(slug: string, patch: StatePatch): Promise<void> {
  const db = await getDb();
  const set = { ...patch, updatedAt: new Date() };
  await db
    .insert(rendererBundleUpdates)
    .values({ slug, ...set })
    .onConflictDoUpdate({ target: rendererBundleUpdates.slug, set });
}

const NO_REFUSAL: StatePatch = {
  refusalCode: null,
  refusalMessage: null,
  refusedAt: null,
};
const NO_HOLD: StatePatch = {
  holdVersion: null,
  holdReason: null,
  holdDetail: null,
  heldAt: null,
};

async function recordRefusal(slug: string, err: unknown): Promise<string> {
  const reasonCode = reasonCodeOf(err);
  await patchState(slug, {
    refusalCode: reasonCode,
    refusalMessage: messageOf(err),
    refusedAt: new Date(),
    applyAfter: null,
  });
  return reasonCode;
}

async function recordHold(
  slug: string,
  version: string,
  reason: RendererBundleHoldReason,
  detail: string
): Promise<void> {
  await patchState(slug, {
    holdVersion: version,
    holdReason: reason,
    holdDetail: detail,
    heldAt: new Date(),
    applyAfter: null,
  });
}

/** The slug that holds the pod's host-module set, if any. */
async function hostSetHolder(): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ slug: rendererHostModules.bundleSlug })
    .from(rendererHostModules)
    .limit(1);
  return row?.slug ?? null;
}

async function installedVersionOf(slug: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ version: rendererBundles.version })
    .from(rendererBundles)
    .where(eq(rendererBundles.slug, slug))
    .limit(1);
  return row?.version ?? null;
}

/**
 * Apply one version of the official bundle (the update door of a person and
 * of the pass): fetch, admit, install, receipt. Landed: the hold and the
 * refusal are cleared, nothing waits. A bundle this pod cannot run yet is
 * HELD for the owner (and the refusal rethrown).
 */
export async function applyRendererBundleUpdate(input: {
  slug: string;
  version: string;
  userId: string;
  appliedBy: "person" | "automatic";
}): Promise<{
  receipt: PackageUpdateReceipt | null;
  previousVersion: string | null;
}> {
  try {
    const out = await installOfficialRendererBundle(input);
    await patchState(input.slug, {
      ...NO_HOLD,
      ...NO_REFUSAL,
      applyAfter: null,
    });
    return { receipt: out.receipt, previousVersion: out.previousVersion };
  } catch (err) {
    if (reasonCodeOf(err) === RENDERER_BUNDLE_REQUIRES_UNMET) {
      await recordHold(input.slug, input.version, "requires", messageOf(err));
    }
    throw err;
  }
}

/**
 * One pass for a bundle (Synap's own by default). Never throws for a refusal
 * or a failed read: it records it and says so; a database failure throws.
 */
export async function syncRendererBundleUpdates(input: {
  /** null: the setting could not be read, so nothing applies on its own. */
  settings: RendererUpdateSettings | null;
  slug?: string;
  now?: Date;
}): Promise<RendererBundleSyncOutcome> {
  const slug = input.slug ?? SYNAP_RENDERERS_SLUG;
  const now = input.now ?? new Date();

  const holder = await hostSetHolder();
  if (holder && holder !== slug) return { kind: "other-bundle", holder };

  let meta: Awaited<ReturnType<typeof fetchOfficialRendererBundleMeta>>;
  try {
    meta = await fetchOfficialRendererBundleMeta({ slug });
  } catch (err) {
    return { kind: "refused", reasonCode: await recordRefusal(slug, err) };
  }

  const state = await readRow(slug);
  await patchState(slug, {
    latestVersion: meta.version,
    latestContentHash: meta.contentHash,
    latestPublishedAt: meta.publishedAt,
    checkedAt: now,
    ...NO_REFUSAL,
    // A newer version releases a hold on an older one.
    ...(state?.holdVersion && state.holdVersion !== meta.version
      ? NO_HOLD
      : {}),
  });
  const held = activeHold(state, meta.version);

  const installed = await installedVersionOf(slug);

  // D2: no bundle yet, and a plan covers the pod (the read above answered).
  if (!installed) {
    if (held) return { kind: "held", latest: meta.version, reason: held };
    const owner = await resolvePodOwnerUserId();
    if (!owner) {
      return {
        kind: "refused",
        reasonCode: await recordRefusal(
          slug,
          new Error(
            "This pod has no owner yet, so its renderers are installed once it has one."
          )
        ),
      };
    }
    try {
      await applyRendererBundleUpdate({
        slug,
        version: meta.version,
        userId: owner,
        appliedBy: "automatic",
      });
      return { kind: "installed", version: meta.version };
    } catch (err) {
      if (reasonCodeOf(err) === RENDERER_BUNDLE_REQUIRES_UNMET) {
        return { kind: "held", latest: meta.version, reason: "requires" };
      }
      return { kind: "refused", reasonCode: await recordRefusal(slug, err) };
    }
  }

  if (installed === meta.version) {
    await patchState(slug, { installedRetired: false, applyAfter: null });
    return { kind: "current", version: installed };
  }

  // D8: was the installed version retired? A failed read is "not known to
  // be", so the update keeps its soak (logged, never a skipped wait).
  let retired = false;
  try {
    retired = (
      await fetchOfficialRendererBundleMeta({ slug, version: installed })
    ).retired;
  } catch (err) {
    logger.warn(
      { err, slug, installed },
      "Could not read whether the installed renderer bundle was retired; its update keeps its soak"
    );
  }
  await patchState(slug, { installedRetired: retired });

  if (state?.stoppedAt) {
    await patchState(slug, { applyAfter: null });
    return { kind: "stopped", latest: meta.version };
  }
  if (held) {
    await patchState(slug, { applyAfter: null });
    return { kind: "held", latest: meta.version, reason: held };
  }
  if (!input.settings?.auto) {
    await patchState(slug, { applyAfter: null });
    return { kind: "manual", latest: meta.version };
  }

  const applyAfter = retired
    ? now
    : new Date(
        meta.publishedAt.getTime() +
          RENDERER_BUNDLE_SOAK_MS[input.settings.channel]
      );
  if (now.getTime() < applyAfter.getTime()) {
    await patchState(slug, { applyAfter });
    return { kind: "waiting", latest: meta.version, applyAfter };
  }

  const owner = await resolvePodOwnerUserId();
  if (!owner) {
    return {
      kind: "refused",
      reasonCode: await recordRefusal(
        slug,
        new Error(
          "This pod has no owner, so its renderers do not update on their own."
        )
      ),
    };
  }
  try {
    await applyRendererBundleUpdate({
      slug,
      version: meta.version,
      userId: owner,
      appliedBy: "automatic",
    });
    return { kind: "updated", from: installed, to: meta.version };
  } catch (err) {
    if (reasonCodeOf(err) === RENDERER_BUNDLE_REQUIRES_UNMET) {
      return { kind: "held", latest: meta.version, reason: "requires" };
    }
    return { kind: "refused", reasonCode: await recordRefusal(slug, err) };
  }
}

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

/**
 * What pod admin's Renderers card reads (`renderers.updates`): the state of
 * the bundle that holds the pod's host set, else of Synap's own (so a refusal
 * shows on a pod with no bundle). null = never read.
 */
export async function readRendererBundleUpdateState(): Promise<RendererBundleUpdateState | null> {
  const slug = (await hostSetHolder()) ?? SYNAP_RENDERERS_SLUG;
  const row = await readRow(slug);
  if (!row) return null;
  return {
    slug,
    latestVersion: row.latestVersion,
    latestPublishedAt: iso(row.latestPublishedAt),
    checkedAt: iso(row.checkedAt),
    installedRetired: row.installedRetired,
    refusal:
      row.refusalCode && row.refusedAt
        ? {
            reasonCode: row.refusalCode,
            message: row.refusalMessage ?? "",
            at: row.refusedAt.toISOString(),
          }
        : null,
    hold:
      row.holdVersion && row.holdReason && row.heldAt
        ? {
            version: row.holdVersion,
            reason: row.holdReason as RendererBundleHoldReason,
            detail: row.holdDetail ?? "",
            at: row.heldAt.toISOString(),
          }
        : null,
    stoppedAt: iso(row.stoppedAt),
    applyAfter: iso(row.applyAfter),
  };
}

/** The latest version the pass read for each bundle, with why when none. */
export async function readRendererBundleLatest(): Promise<
  Map<string, { latestVersion: string | null; reason: string | null }>
> {
  const db = await getDb();
  const rows = await db
    .select({
      slug: rendererBundleUpdates.slug,
      latestVersion: rendererBundleUpdates.latestVersion,
      refusalMessage: rendererBundleUpdates.refusalMessage,
    })
    .from(rendererBundleUpdates);
  return new Map(
    rows.map((r) => [
      r.slug,
      { latestVersion: r.latestVersion, reason: r.refusalMessage },
    ])
  );
}

/** "Stop updates" (the owner's pin) and back on. A person's act. */
export async function setRendererBundleUpdatesStopped(input: {
  slug: string;
  stopped: boolean;
  userId: string;
}): Promise<RendererBundleUpdateState | null> {
  await patchState(input.slug, {
    stoppedAt: input.stopped ? new Date() : null,
    stoppedBy: input.stopped ? input.userId : null,
    applyAfter: null,
  });
  return readRendererBundleUpdateState();
}

/**
 * Undo a renderer bundle update: re-install the version it replaced, from the
 * definition kept on the pod, re-admitted against the digest recorded at its
 * install (D7), never fetched again. The caller checked the receipt (not
 * undone, inside the window). A person's act: an agent is refused.
 */
export async function undoRendererBundleUpdate(
  ctx: Context,
  receipt: PackageUpdateReceipt
): Promise<PackageUpdateApplyResult> {
  if (
    getActingAgentUserId() ??
    (ctx as { agentUserId?: string | null }).agentUserId
  ) {
    throw packageUpdateRefusal(
      "FORBIDDEN",
      "NEEDS_PERSON",
      "An agent cannot undo a renderer update: a person does it on pod admin (Pod updates › Renderers)."
    );
  }
  const slug = receipt.slug;
  const from = receipt.fromVersion;
  const to = receipt.toVersion;
  if (!from || !to) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This update has no version to go back to.",
    });
  }
  const installed = await installedVersionOf(slug);
  if (installed !== to) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Changed again since this update: the pod now runs ${installed ?? "no renderers"}, not ${to}. Nothing was undone.`,
    });
  }
  const db = await getDb();
  const [kept] = await db
    .select()
    .from(rendererBundleVersions)
    .where(
      and(
        eq(rendererBundleVersions.slug, slug),
        eq(rendererBundleVersions.version, from)
      )
    )
    .limit(1);
  if (!kept) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The version before this update (${from}) is no longer kept on this pod. Nothing was undone.`,
    });
  }
  if (rendererBundleContentHash(kept.definition) !== kept.contentHash) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `The kept copy of ${from} no longer matches the digest recorded when it was installed, so it is not installed again. Nothing was undone.`,
      cause: { code: "MARKET_OFFICIAL_UNVERIFIED" },
    });
  }
  const userId = ctx.userId as string;
  await installRendererBundle(kept.definition, {
    userId,
    source: OFFICIAL_SOURCE_ID,
    version: from,
  });
  // The undone version does not come back by itself; a newer one does.
  await recordHold(
    slug,
    to,
    "undone",
    `You went back to ${from}: ${to} does not apply on its own again.`
  );
  await recordPackageUpdateUndone({
    receipt,
    userId,
    changes: [
      {
        rowKind: RENDERER_BUNDLE_KIND,
        rowId: slug,
        field: "version",
        before: to,
        after: from,
      },
    ],
  });
  return {
    status: "applied",
    receipt: { ...receipt, undoneAt: new Date().toISOString() },
  };
}
