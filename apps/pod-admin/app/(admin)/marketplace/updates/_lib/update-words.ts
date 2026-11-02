/**
 * The few phrases the list, the Review page and the package page build the
 * same way from the folder's catalogs. Lists of separate messages joined by
 * " · " (never one sentence assembled from parts, rule i18n §3).
 */

import type { TFunction } from "@synap-core/types/i18n";
import type { PackageFieldState, PackageUpdateSummary } from "./contract";
import { catalogKindLabel } from "../../_lib/catalog-model";
import type { en } from "./copy";
import { stateCounts, updateGroupOf, type UpdateGroup } from "./updates-model";

type T = TFunction<typeof en>;

/** One state's count, in words. A literal key per state keeps `t` typed. */
export function stateCountLabel(
  t: T,
  state: PackageFieldState,
  n: number
): string {
  switch (state) {
    case "both":
      return t("count.both", { n });
    case "updates":
      return t("count.updates", { n });
    case "yours":
      return t("count.yours", { n });
    case "same":
      return t("count.same", { n });
  }
}

/** "1 to choose · 4 update on their own · 2 stay yours" (+ records). */
export function countsLine(
  t: T,
  s: Pick<PackageUpdateSummary, "counts" | "dataChanges">,
  { withSame = false }: { withSame?: boolean } = {}
): string {
  const parts = stateCounts(s.counts)
    .filter((c) => withSame || c.state !== "same")
    .map((c) => stateCountLabel(t, c.state, c.count));
  if (s.dataChanges > 0) parts.push(t("count.data", { n: s.dataChanges }));
  return parts.join(" · ");
}

/** "Skill · 1 to choose · 2 stay yours": a row's second line. */
export function rowSecondary(t: T, s: PackageUpdateSummary): string {
  return t("row.secondary", {
    kind: catalogKindLabel(s.kind),
    counts: countsLine(t, s),
  });
}

/** The words of an update's mark, from the group it sits in. */
export function groupMarkLabel(t: T, group: UpdateGroup | "current"): string {
  switch (group) {
    case "choice":
      return t("mark.choice");
    case "consent":
      return t("mark.consent");
    case "review":
      return t("mark.review");
    case "nothing":
      return t("mark.nothing");
    case "current":
      return t("mark.current");
  }
}

/** The group and the words of an update's mark, in one read. */
export function summaryMark(
  t: T,
  s: Pick<PackageUpdateSummary, "needs" | "counts">
): { group: UpdateGroup | "current"; label: string } {
  const group = updateGroupOf(s);
  return { group, label: groupMarkLabel(t, group) };
}
