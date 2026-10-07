/**
 * An Application as pod-admin's two app surfaces read it — the "Connected"
 * list (`/my-connections`) and one app's page (`/apps/[publicId]`).
 *
 * Nothing is derived here. Standing (asking, setting up, ready, quiet, key
 * expired, revoked…) is the membrane rule (`resolveAppConnection`), reach is
 * the shared `app-view` leaf, words come from the vocabulary door. This file
 * only types the proxy's wire row and maps the membrane's tone TOKEN into a
 * HeroUI chip colour — the one thing that is genuinely pod-admin's.
 */

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@synap-core/api-types";
import type { ConnectionState } from "@synap-core/types/membrane";
import type { UnitTone } from "@synap-core/types/units";

type RouterOutputs = inferRouterOutputs<AppRouter>;

/**
 * A procedure output as the same-origin proxy (`/api/apps`) serves it: plain
 * JSON, so every `Date` in the generated type arrives as an ISO string.
 */
type Wire<T> = T extends Date
  ? string
  : T extends ReadonlyArray<infer U>
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

/** One `apps.list` row (generated snapshot). `grants` are its LIVE reach. */
export type AppRow = Wire<RouterOutputs["apps"]["list"][number]>;

/** One `apps.get` row — an `AppRow` plus its keys (key health is read from them). */
export type AppDetailRow = Wire<RouterOutputs["apps"]["get"]>;

export type ChipColor = "default" | "primary" | "success" | "warning" | "danger";

const CHIP_COLOR: Record<UnitTone, ChipColor> = {
  primary: "primary",
  ai: "primary",
  info: "primary",
  error: "danger",
  success: "success",
  warning: "warning",
  textSecondary: "default",
  textMuted: "default",
};

/** The HeroUI chip colour for a membrane tone token. */
export function chipColor(tone: UnitTone): ChipColor {
  return CHIP_COLOR[tone];
}

/**
 * What Revoke does IN THIS STATE. True to the pod (`revokeApp`): a waiting
 * request is withdrawn, keys stop, reach is dropped, history stays.
 */
export function revokeConsequence(state: ConnectionState): string {
  if (state === "asking")
    return "Cancels the request and cuts the app off. It can ask again later.";
  if (state === "setting_up")
    return "It has no access yet. This stops it from asking.";
  return "This app loses access to this Pod and its key stops working.";
}
