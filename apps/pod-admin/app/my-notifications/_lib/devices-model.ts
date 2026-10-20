/**
 * `/my-notifications` as the console shows it — pure, so every rule is
 * unit-tested. The words for a phone and a push category come from
 * `@synap-core/types/push` (the phone app reads the same ones); this file only
 * arranges them for the console: list order, the row's secondary line, the
 * pill, the section's summary sentence.
 */

import {
  PUSH_DEVICE_COPY,
  comparePushDevices,
  pushDeviceFacts,
  pushDeviceView,
  resolvePushCategoryLabel,
  type PushDeviceRow,
  type PushDeviceView,
} from "@synap-core/types/push";
import { formatRelative } from "../../../lib/format";
import type { StatusKind } from "../../(admin)/components/status-pill";

/** The rows of `notifCenter.listDevices`, as views, in list order. */
export function phoneViews(
  rows: readonly PushDeviceRow[] | undefined,
  now: Date = new Date()
): PushDeviceView[] {
  return (rows ?? [])
    .map((r) => pushDeviceView(r, now))
    .sort(comparePushDevices);
}

/**
 * The line under a phone's name: the shared facts line (`pushDeviceFacts`,
 * the phone app's own), led — since the pill hides on a narrow screen — by
 * its state when it is not plain "On".
 */
export function phoneSecondary(view: PushDeviceView): string {
  const facts = pushDeviceFacts(view, (at) => formatRelative(at));
  return [view.state === "on" ? null : view.statusLabel, facts || null]
    .filter(Boolean)
    .join(" · ");
}

/** The pill: none for a phone that simply gets its pushes (healthy is quiet). */
export function phonePill(
  view: PushDeviceView
): { kind: StatusKind; label: string } | undefined {
  return view.state === "on"
    ? undefined
    : { kind: view.tone, label: view.statusLabel };
}

/** The phones section's one sentence. */
export function phonesSummary(views: readonly PushDeviceView[]): string {
  const on = views.filter(
    (v) => v.state === "on" || v.state === "not-seen"
  ).length;
  const quiet = views.filter((v) => v.state === "not-seen").length;
  const head =
    on === 0
      ? "No phone gets your notifications right now."
      : `${on} ${on === 1 ? "phone gets" : "phones get"} your notifications.`;
  return quiet > 0 ? `${head} ${quiet} not used lately.` : head;
}

/** What turning a phone off says before it happens. */
export function turnOffCopy(view: PushDeviceView): {
  title: string;
  consequence: string;
  confirmLabel: string;
} {
  return {
    title: PUSH_DEVICE_COPY.turnOffTitle(view.label),
    consequence: PUSH_DEVICE_COPY.turnOffConsequence,
    confirmLabel: PUSH_DEVICE_COPY.turnOffAction,
  };
}

/** One toggle row per push category (`notifCenter.pushPrefs`). */
export function categoryRows<C extends string>(
  categories: ReadonlyArray<{ category: C; enabled: boolean }> | undefined
): Array<{ category: C; name: string; hint: string; enabled: boolean }> {
  return (categories ?? []).map((c) => ({
    category: c.category,
    ...resolvePushCategoryLabel(c.category),
    enabled: c.enabled,
  }));
}
