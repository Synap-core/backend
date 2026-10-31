/**
 * The pod's template-update door, as pod admin reads it: the contract is the
 * pod's (`@synap-core/types/package-updates`, the words of each state
 * `@synap-core/types/vocabulary`), re-exported here so this folder imports
 * one module, and a rename on the pod is one edit in this file.
 */

export {
  PACKAGE_FIELD_STATES,
  PACKAGE_UPDATE_NEEDS,
  type ApplyPackageUpdateInput,
  type PackageDataChange,
  type PackageFieldCounts,
  type PackageFieldState,
  type PackageUpdateApplyResult,
  type PackageUpdateChoice,
  type PackageUpdateChoiceName,
  type PackageUpdateField,
  type PackageUpdateList,
  type PackageUpdateNeeds,
  type PackageUpdatePlan,
  type PackageUpdateReceipt,
  type PackageUpdateRowKind,
  type PackageUpdateSummary,
} from "@synap-core/types/package-updates";

export {
  resolvePackageFieldLabel as packageFieldLabel,
  resolvePackageFieldStateLabel as packageFieldStateLabel,
  resolvePackageUpdateNeedsLabel as packageUpdateNeedsLabel,
} from "@synap-core/types/vocabulary";

/** One installed row of a plan (a skill, a view, an automation). */
export type PackageUpdateRow =
  import("@synap-core/types/package-updates").PackageUpdatePlan["rows"][number];

/** A package whose catalog the pod could not read, with why. */
export type PackageUpdateUnreadable =
  import("@synap-core/types/package-updates").PackageUpdateList["unreadable"][number];

/** The key a choice is filed under: one field of one row. */
export function choiceKey(rowId: string, field: string): string {
  return `${rowId}:${field}`;
}
