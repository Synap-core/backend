/**
 * Pod updates' Renderers row: whether Synap's renderers are on this pod, the
 * one action that fits, and why the last install was refused.
 *
 * The state is `renderers.status` (read through `readRenderersStatus`, the
 * same parser the object frame uses). The install is `marketplace.install`
 * kind `renderer-bundle`: the one install core (`runMarketInstall`) the
 * `market.install` verb runs too. A refusal is read from the install's own
 * error (`error.data.reasonCode`, set by `official-renderer-bundle.ts` and
 * `install-renderer-bundle.ts`) until the next try or a reload.
 *
 * Updates (plan ad703ccd L2) come from the pod's package updates, never a
 * second updater: what the 10-minute pass last read (`renderers.updates`:
 * the newest version, when it applies on its own, a hold, a refusal, "Stop
 * updates") and the last receipt (`packageUpdates.history`, with its Undo).
 * A refusal the pass recorded (a plan pod's first-sync install, D2) is worded
 * by the SAME reason map as an install's.
 */
import type {
  PackageUpdateReceipt,
  RendererBundleUpdateState,
} from "@synap-core/types/package-updates";
import type { RenderersStatus } from "../../../_lib/object/content/use-object-renderer";

/** Synap's own renderer bundle (published from app-bases `renderer-bundles/`). */
export const SYNAP_RENDERERS_SLUG = "synap-renderers";

/** Why an install of Synap's renderers did not go through. */
export type RenderersRefusal =
  | "plan_required"
  | "pod_not_enrolled"
  | "no_control_plane"
  | "insecure_control_plane"
  | "pod_not_live"
  | "other_renderers"
  | "needs_newer_pod"
  | "failed";

/**
 * The pod's machine reason → the refusal this row words. Every
 * `renderer_bundle_*` code the pod's fetch can throw is mapped
 * (`renderers-model.test.ts` reads them from the pod's source).
 */
const REFUSAL_BY_REASON: Readonly<Record<string, RenderersRefusal>> = {
  renderer_bundle_plan_required: "plan_required",
  renderer_bundle_pod_not_enrolled: "pod_not_enrolled",
  renderer_bundle_no_control_plane: "no_control_plane",
  renderer_bundle_insecure_control_plane: "insecure_control_plane",
  renderer_bundle_pod_not_live: "pod_not_live",
  RENDERER_HOST_SET_TAKEN: "other_renderers",
  RENDERER_BUNDLE_REQUIRES_UNMET: "needs_newer_pod",
};

/** The machine reasons this row words (for the parity test). */
export const WORDED_REASONS: readonly string[] = Object.keys(REFUSAL_BY_REASON);

/** The refusal a machine reason words; anything unknown is `failed`. */
function refusalOfReason(code: unknown): RenderersRefusal {
  return (typeof code === "string" && REFUSAL_BY_REASON[code]) || "failed";
}

/** The refusal behind a failed install; anything untyped is `failed`. */
export function renderersRefusalOf(err: unknown): RenderersRefusal {
  const data = (err as { data?: { reasonCode?: unknown } | null } | null)?.data;
  return refusalOfReason(data?.reasonCode);
}

/** Where the pod stands: Synap's renderers, another set, or none. */
export type RenderersState =
  | { kind: "installed"; version: string }
  | { kind: "other"; slug: string; version: string }
  | { kind: "none" };

/** The one action that applies now; null when none can. */
export type RenderersAction = "install" | "reinstall" | null;

export interface RenderersRowView {
  state: RenderersState;
  action: RenderersAction;
}

/**
 * (status) → what the row shows. A pod holds ONE renderer set at a time
 * (`renderer_host_modules_one_set`), so with another set installed Synap's
 * cannot be installed and no action is offered.
 */
export function renderersRowView(status: RenderersStatus): RenderersRowView {
  const bundle = status.bundle;
  if (!bundle) return { state: { kind: "none" }, action: "install" };
  if (bundle.slug === SYNAP_RENDERERS_SLUG) {
    return {
      state: { kind: "installed", version: bundle.version },
      action: "reinstall",
    };
  }
  return {
    state: { kind: "other", slug: bundle.slug, version: bundle.version },
    action: null,
  };
}

// ─── Updates ────────────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === "string";
const strOrNull = (v: unknown): string | null => (isStr(v) ? v : null);

/**
 * `renderers.updates` as pod admin reads it; null when the pod never read
 * its control plane, or the answer is not one this page knows (never a
 * guessed "up to date").
 */
export function readRenderersUpdates(
  data: unknown
): RendererBundleUpdateState | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!isStr(d.slug)) return null;
  const refusal = d.refusal as Record<string, unknown> | null | undefined;
  const hold = d.hold as Record<string, unknown> | null | undefined;
  return {
    slug: d.slug,
    latestVersion: strOrNull(d.latestVersion),
    latestPublishedAt: strOrNull(d.latestPublishedAt),
    checkedAt: strOrNull(d.checkedAt),
    installedRetired: d.installedRetired === true,
    refusal:
      refusal && isStr(refusal.reasonCode) && isStr(refusal.at)
        ? {
            reasonCode: refusal.reasonCode,
            message: isStr(refusal.message) ? refusal.message : "",
            at: refusal.at,
          }
        : null,
    hold:
      hold &&
      isStr(hold.version) &&
      isStr(hold.at) &&
      (hold.reason === "requires" || hold.reason === "undone")
        ? {
            version: hold.version,
            reason: hold.reason,
            detail: isStr(hold.detail) ? hold.detail : "",
            at: hold.at,
          }
        : null,
    stoppedAt: strOrNull(d.stoppedAt),
    applyAfter: strOrNull(d.applyAfter),
  };
}

/**
 * Why a newer version has not applied yet:
 *   auto     — it applies on its own at `applyAfter` (the soak, D1);
 *   manual   — automatic updates are off on this pod: the person applies it;
 *   stopped  — the person stopped updates: they apply it;
 *   requires — it needs a newer pod;
 *   undone   — the person went back from it: it does not come back alone.
 */
export type RenderersUpdateWait =
  "auto" | "manual" | "stopped" | "requires" | "undone";

export interface RenderersUpdatesView {
  /** The last pass was refused (a plan pod's own install, D2), worded. */
  refusal: RenderersRefusal | null;
  /** A newer version of Synap's renderers waits. */
  available: {
    version: string;
    wait: RenderersUpdateWait;
    applyAfter: string | null;
  } | null;
  /** The last update, while it can still be undone. */
  undoable: {
    receiptId: string;
    version: string;
    at: string;
    automatic: boolean;
  } | null;
  /** The person stopped updates. */
  stopped: boolean;
}

/**
 * (status, what the pass read, the last receipt, now) → what the row says
 * about updates. Only Synap's own installed bundle is updated here.
 */
export function renderersUpdatesView(
  status: RenderersStatus,
  updates: RendererBundleUpdateState | null,
  receipt: PackageUpdateReceipt | null,
  now: number
): RenderersUpdatesView {
  const installed =
    status.bundle?.slug === SYNAP_RENDERERS_SLUG ? status.bundle.version : null;
  const ours = updates?.slug === SYNAP_RENDERERS_SLUG ? updates : null;
  const latest = ours?.latestVersion ?? null;

  let available: RenderersUpdatesView["available"] = null;
  if (installed && latest && latest !== installed) {
    const hold = ours?.hold?.version === latest ? ours.hold : null;
    const wait: RenderersUpdateWait = ours?.stoppedAt
      ? "stopped"
      : hold
        ? hold.reason
        : ours?.applyAfter
          ? "auto"
          : "manual";
    available = {
      version: latest,
      wait,
      applyAfter: wait === "auto" ? (ours?.applyAfter ?? null) : null,
    };
  }

  const undoable =
    installed &&
    receipt &&
    receipt.slug === SYNAP_RENDERERS_SLUG &&
    !receipt.undoneAt &&
    receipt.fromVersion &&
    receipt.toVersion === installed &&
    now < Date.parse(receipt.undoUntil)
      ? {
          receiptId: receipt.id,
          version: installed,
          at: receipt.appliedAt,
          automatic: receipt.source === "automatic",
        }
      : null;

  return {
    refusal: ours?.refusal ? refusalOfReason(ours.refusal.reasonCode) : null,
    available,
    undoable,
    stopped: !!ours?.stoppedAt,
  };
}
