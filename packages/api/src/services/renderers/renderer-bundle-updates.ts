/**
 * Renderer bundle UPDATES: the bundle is one more whole-package kind of the
 * pod's package updates (`services/package-updates/`). The standing reads
 * what this module records; the apply and Undo doors call it.
 *
 * THE PASS (`syncRendererBundleUpdates`) runs after each official catalog
 * sync (every 10 minutes, `registerOfficialCatalogSyncedHandler`, apps/api):
 *
 *   1. another bundle holds the pod's host-module set → nothing to do;
 *   2. read the control plane's METADATA of the bundle (`?meta=1`: no
 *      definition, no delivery row). A refusal (no plan, not enrolled…) is
 *      recorded with the pod's machine reason, and the pass stops;
 *   3. no bundle installed → install it now: the read in 2 proved a plan
 *      covers the pod, and there is nothing on the pod to protect;
 *   4. the installed version is the newest → nothing waits;
 *   5. otherwise the update waits, and the row says why (`waitReason`): the
 *      owner paused it, a hold on this version, automatic updates off (the
 *      pod's ONE setting `pod_settings.settings.updates`) or unreadable,
 *      Synap's catalog frozen, the soak (from the publish date; none when
 *      Synap retired the installed version), no owner to apply it as. Else it
 *      applies on its own, as the owner.
 *
 * A failed apply on its own HOLDS that version (it is not fetched again until
 * a newer version, a person's apply, or a restart for `requires`/`failed`):
 * the definition is ~3 MB and every fetch is a delivery row on the control
 * plane.
 */

import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { getDb, and, eq } from "@synap/database";
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
  PACKAGE_UPDATES_PAUSED_EVENT_TYPE,
  PACKAGE_UPDATES_RESUMED_EVENT_TYPE,
  RENDERER_BUNDLE_HOLD_REASONS,
  RENDERER_BUNDLE_SOAK_MS,
  RENDERER_BUNDLE_WAIT_REASONS,
  type PackageUpdateApplyResult,
  type PackageUpdateReceipt,
  type RendererBundleHoldReason,
  type RendererBundleUpdateState,
  type RendererBundleWaitReason,
} from "@synap-core/types/package-updates";

import type { Context } from "../../types/context.js";
import { logEvent } from "../../lib/event-helpers.js";
import { officialCatalogStandingNow } from "../capabilities/official-catalog-trust.js";
import { resolvePodOwnerUserId } from "../capabilities/pod-owner.js";
import { recordPackageUpdateUndone } from "../package-updates/receipts.js";
import { refuseAgentCaller } from "../package-updates/refusals.js";
import {
  installRendererBundle,
  rendererBundleContentHash,
  RENDERER_BUNDLE_REQUIRES_UNMET,
} from "./install-renderer-bundle.js";
import {
  fetchOfficialRendererBundleMeta,
  installOfficialRendererBundle,
  RENDERER_BUNDLE_KIT_REMOVED,
  SYNAP_RENDERERS_SLUG,
} from "./official-renderer-bundle.js";
import {
  NO_HOLD,
  NO_REFUSAL,
  NOTHING_WAITS,
  patchRendererBundleUpdateRow as patchState,
  readRendererBundleUpdateRow as readRow,
} from "./renderer-bundle-update-state.js";

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
  | { kind: "updated"; from: string; to: string }
  | {
      kind: "waits";
      latest: string;
      reason: RendererBundleWaitReason;
      hold?: RendererBundleHoldReason;
      applyAfter?: Date;
    };

/**
 * When this process started. A pod update restarts it, so a version held for
 * `requires` or `failed` is tried again once by the new process: the pod's
 * contract may have caught up.
 */
const PROCESS_STARTED_AT = new Date();
const RETRIED_AFTER_RESTART: ReadonlySet<RendererBundleHoldReason> = new Set([
  "requires",
  "failed",
]);

/** The hold that keeps `latest` waiting, if any. */
function activeHold(
  state: RendererBundleUpdatesRow | null,
  latest: string
): RendererBundleHoldReason | null {
  const reason = RENDERER_BUNDLE_HOLD_REASONS.find(
    (r) => r === state?.holdReason
  );
  if (!reason || state?.holdVersion !== latest) return null;
  if (
    RETRIED_AFTER_RESTART.has(reason) &&
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

/** Which hold a failed apply of one version becomes. */
function holdReasonOf(err: unknown): RendererBundleHoldReason {
  const code = reasonCodeOf(err);
  if (code === RENDERER_BUNDLE_REQUIRES_UNMET) return "requires";
  if (code === RENDERER_BUNDLE_KIT_REMOVED) return "kit";
  return "failed";
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
    waitReason: "held",
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
 * Apply one version of the official bundle: a person's apply, and the pass's.
 * Fetch, admit, install, receipt (the install door clears the row). The pass
 * also holds a version that drops kit exports another cell may use; a failure
 * of the pass holds its version, and a version this pod cannot run waits for
 * the pod whoever asked.
 */
export async function applyRendererBundleUpdate(input: {
  slug: string;
  version: string;
  userId: string;
  appliedBy: "person" | "automatic";
}): Promise<{ receipt: PackageUpdateReceipt | null }> {
  try {
    const out = await installOfficialRendererBundle({
      ...input,
      holdKitRemoval: input.appliedBy === "automatic",
    });
    return { receipt: out.receipt };
  } catch (err) {
    const hold = holdReasonOf(err);
    if (input.appliedBy === "automatic" || hold === "requires") {
      await recordHold(input.slug, input.version, hold, messageOf(err));
    }
    throw err;
  }
}

/**
 * One pass for Synap's renderer bundle. Never throws for a refusal or a
 * failed apply: it records it and says so; a database failure throws.
 */
export async function syncRendererBundleUpdates(input: {
  /** null: the setting could not be read, so nothing updates on its own. */
  settings: RendererUpdateSettings | null;
  now?: Date;
}): Promise<RendererBundleSyncOutcome> {
  const slug = SYNAP_RENDERERS_SLUG;
  const now = input.now ?? new Date();

  const holder = await hostSetHolder();
  if (holder && holder !== slug) return { kind: "other-bundle", holder };

  let meta: Awaited<ReturnType<typeof fetchOfficialRendererBundleMeta>>;
  try {
    meta = await fetchOfficialRendererBundleMeta({ slug });
  } catch (err) {
    const reasonCode = reasonCodeOf(err);
    await patchState(slug, {
      refusalCode: reasonCode,
      refusalMessage: messageOf(err),
      refusedAt: now,
      waitReason: "refused",
      applyAfter: null,
    });
    return { kind: "refused", reasonCode };
  }

  const state = await readRow(slug);
  await patchState(slug, {
    latestVersion: meta.version,
    latestPublishedAt: meta.publishedAt,
    checkedAt: now,
    ...NO_REFUSAL,
    // A newer version releases a hold on an older one.
    ...(state?.holdVersion && state.holdVersion !== meta.version
      ? NO_HOLD
      : {}),
  });
  const installed = await installedVersionOf(slug);
  if (installed === meta.version) {
    await patchState(slug, { installedRetired: false, ...NOTHING_WAITS });
    return { kind: "current", version: installed };
  }

  const waits = async (
    reason: RendererBundleWaitReason,
    extra: { hold?: RendererBundleHoldReason; applyAfter?: Date } = {}
  ): Promise<RendererBundleSyncOutcome> => {
    await patchState(slug, {
      waitReason: reason,
      applyAfter: extra.applyAfter ?? null,
    });
    return { kind: "waits", latest: meta.version, reason, ...extra };
  };

  // Was the installed version retired? A failed read is "not known to be",
  // so the update keeps its soak (logged, never a skipped wait).
  let retired = false;
  if (installed) {
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
  }

  const held = activeHold(state, meta.version);
  if (held) return waits("held", { hold: held });
  // Pause and the auto setting govern UPDATES; a first install is presence.
  if (installed) {
    if (state?.pausedAt) return waits("paused");
    if (!input.settings) return waits("setting_unreadable");
    if (!input.settings.auto) return waits("auto_off");
  }
  if ((await officialCatalogStandingNow(now)).blocked) return waits("frozen");
  if (installed && input.settings) {
    const applyAfter = retired
      ? now
      : new Date(
          meta.publishedAt.getTime() +
            RENDERER_BUNDLE_SOAK_MS[input.settings.channel]
        );
    if (now.getTime() < applyAfter.getTime()) {
      return waits("soak", { applyAfter });
    }
  }
  const owner = await resolvePodOwnerUserId();
  if (!owner) return waits("no_owner");

  try {
    await applyRendererBundleUpdate({
      slug,
      version: meta.version,
      userId: owner,
      appliedBy: "automatic",
    });
  } catch (err) {
    logger.warn(
      { err, slug, version: meta.version },
      "Applying the renderer bundle on its own failed; that version waits for a person"
    );
    return {
      kind: "waits",
      latest: meta.version,
      reason: "held",
      hold: holdReasonOf(err),
    };
  }
  return installed
    ? { kind: "updated", from: installed, to: meta.version }
    : { kind: "installed", version: meta.version };
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
  const holdReason = RENDERER_BUNDLE_HOLD_REASONS.find(
    (r) => r === row.holdReason
  );
  const waitReason =
    RENDERER_BUNDLE_WAIT_REASONS.find((r) => r === row.waitReason) ?? null;
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
      row.holdVersion && holdReason && row.heldAt
        ? {
            version: row.holdVersion,
            reason: holdReason,
            detail: row.holdDetail ?? "",
            at: row.heldAt.toISOString(),
          }
        : null,
    pausedAt: iso(row.pausedAt),
    waitReason,
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

/**
 * Pause one bundle's updates, or resume them: a person's act, written to
 * the pod's log. Paused, a newer version is listed and applies only when a
 * person applies it.
 */
export async function setRendererBundleUpdatesPaused(
  ctx: Context,
  input: { slug: string; paused: boolean }
): Promise<RendererBundleUpdateState | null> {
  refuseAgentCaller(
    ctx as { agentUserId?: string | null },
    "An agent cannot pause or resume renderer updates: a person does it on pod admin (Pod updates › Renderers)."
  );
  const userId = ctx.userId as string;
  const state = await readRow(input.slug);
  const waiting = !!state?.waitReason && state.waitReason !== "refused";
  await patchState(input.slug, {
    pausedAt: input.paused ? new Date() : null,
    // What the card says until the next pass decides again.
    ...(waiting
      ? { waitReason: input.paused ? "paused" : null, applyAfter: null }
      : {}),
  });
  await logEvent(
    userId,
    input.paused
      ? PACKAGE_UPDATES_PAUSED_EVENT_TYPE
      : PACKAGE_UPDATES_RESUMED_EVENT_TYPE,
    { slug: input.slug, kind: RENDERER_BUNDLE_KIND },
    { subjectType: "package", subjectId: input.slug }
  );
  return readRendererBundleUpdateState();
}

/**
 * Undo a renderer bundle update: re-install the version it replaced from the
 * definition kept on the pod (never fetched again), re-admitted against the
 * digest recorded at its install. The caller checked the receipt (not
 * undone, inside the window). A person's act.
 */
export async function undoRendererBundleUpdate(
  ctx: Context,
  receipt: PackageUpdateReceipt
): Promise<PackageUpdateApplyResult> {
  refuseAgentCaller(
    ctx as { agentUserId?: string | null },
    "An agent cannot undo a renderer update: a person does it on pod admin (Pod updates › Renderers)."
  );
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
