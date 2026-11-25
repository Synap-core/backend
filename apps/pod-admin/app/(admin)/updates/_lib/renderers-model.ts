/**
 * Pod updates' Renderers row: whether Synap's renderers are on this pod, the
 * one action that fits, and why the last install was refused.
 *
 * The state is `renderers.status` (read through `readRenderersStatus`, the
 * same parser the object frame uses). The install is `marketplace.install`
 * kind `renderer-bundle`: the one install core (`runMarketInstall`) the
 * `market.install` verb runs too. A refusal is read from the install's own
 * error (`error.data.reasonCode`, set by `official-renderer-bundle.ts` and
 * `install-renderer-bundle.ts`); the pod keeps no record of it, so the reason
 * shows until the next try or a reload.
 *
 * No "update available" check here: the row reinstalls the latest on demand.
 */
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
};

/** The machine reasons this row words (for the parity test). */
export const WORDED_REASONS: readonly string[] = Object.keys(REFUSAL_BY_REASON);

/** The refusal behind a failed install; anything untyped is `failed`. */
export function renderersRefusalOf(err: unknown): RenderersRefusal {
  const data = (err as { data?: { reasonCode?: unknown } | null } | null)?.data;
  const code = data?.reasonCode;
  return (typeof code === "string" && REFUSAL_BY_REASON[code]) || "failed";
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
