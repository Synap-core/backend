/**
 * install-layers — the ONE derivation of `InstallLayerReport[]` from an
 * `applyPackagePostWorkspace` result bag.
 *
 * WHY THIS EXISTS. A package install has two layers, and layer 2
 * (capabilities / playbooks / automations / loops / cells / action placements)
 * can fail at TWO different granularities:
 *
 *   • WHOLE-LAYER — `applyPackagePostWorkspace` threw. The applier stamps
 *     `provisioningStatus:"failed"` into `workspace.settings` before rethrowing,
 *     so this half is durably recorded; the callers turn it into a `failed`
 *     layer entry themselves (they hold the error).
 *   • PER-ITEM — the applier catches each item individually and records
 *     `{status:"error", message}` in its RESULT BAG rather than throwing. This
 *     half was invisible on every door: `market.install` returned the bag
 *     verbatim (nothing reads item statuses) and `createFromDefinition`
 *     discarded it entirely. An install where every capability errored returned
 *     a clean, resolved payload.
 *
 * This module reads the bag and reports the second half. It is pure — no db, no
 * clock, no logger — so both doors can call it and neither can drift into its
 * own copy of the walk.
 *
 * SHAPE, NOT A SECOND SHAPE. The output is `InstallLayerReport` from
 * `@synap/database` (the K8s `status.conditions[]` prior art), which is the same
 * type `createFromDefinition` returns in `layers[]` and the same type
 * `ReconcileReport.layers` carries. There is deliberately no per-door variant.
 */

import type { InstallLayerReport } from "@synap/database";

/**
 * An item the applier reports on: `{status, message?}`, possibly identified.
 *
 * THE IDENTIFIER LIVES UNDER TWO KEYS, and this was read from one producer and
 * asserted over all of them once already. Verified against every
 * `status:"error"` site in `package-apply-post-workspace.ts`:
 *   • `key`  — capabilities (:471, :489), loops (:730), cells (:771, :800)
 *   • `name` — automations (:595), playbooks (:706)
 *   • neither — `agentMembership` (:437) and `projectLink` (:908) are SCALARS,
 *     one per bag, so the bag key alone already identifies them.
 * Both are read below; a new bag must add its identifier field here too.
 */
interface AppliedItem {
  status?: unknown;
  message?: unknown;
  name?: unknown;
  key?: unknown;
}

function isErrorItem(value: unknown): value is AppliedItem {
  return (
    !!value &&
    typeof value === "object" &&
    (value as AppliedItem).status === "error"
  );
}

/** `<bagKey>[:<item name>]: <message>` — enough for an operator to act on. */
function describe(bagKey: string, item: AppliedItem): string {
  const identifier =
    typeof item.name === "string" && item.name
      ? item.name
      : typeof item.key === "string" && item.key
        ? item.key
        : "";
  const name = identifier ? `:${identifier}` : "";
  const message =
    typeof item.message === "string" && item.message ? item.message : "failed";
  return `${bagKey}${name}: ${message}`;
}

/**
 * Walk a post-workspace result bag and report a `post-workspace` FAILED layer
 * when any item inside it errored. Returns `[]` when everything applied —
 * absent means "nothing failed", never "unknown" (`InstallLayerReport`'s
 * contract).
 *
 * Only ERRORS are summarized. A successful layer is not reported as an
 * `applied` entry: `layers[]` is an exception channel, and emitting a row per
 * clean install would make "layers is non-empty" stop meaning "something is
 * wrong" — which is the only thing every consumer needs to branch on.
 */
export function summarizePostWorkspaceLayers(
  bag: Record<string, unknown> | null | undefined
): InstallLayerReport[] {
  if (!bag) return [];
  const failures: string[] = [];
  for (const [key, value] of Object.entries(bag)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isErrorItem(item)) failures.push(describe(key, item));
      }
    } else if (isErrorItem(value)) {
      failures.push(describe(key, value));
    }
  }
  if (failures.length === 0) return [];
  return [
    {
      layer: "post-workspace",
      status: "failed",
      message: `${failures.length} item(s) failed to apply — ${failures.join("; ")}`,
    },
  ];
}
