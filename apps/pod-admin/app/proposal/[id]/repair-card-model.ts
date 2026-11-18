/**
 * What the pod-admin review draws for a proposal whose approval FAILED
 * (decision fa6c8833): one row per field the pod says it cannot carry, each
 * with the fix the reader can apply in one press. Pure: it maps the pod's own
 * projection (`proposals.repairOptions`, `services/proposals/repair-options.ts`)
 * and decides nothing the pod did not say — which value was meant, and
 * whether a value may be added, are the pod's answers.
 */

import { serverErrorHref } from "../../../lib/console-nav";
import type { ConsoleRole } from "../../../lib/route-policy";

/** One field of `proposals.repairOptions`, as the pod returns it. */
export interface RepairOptionsField {
  key: string;
  label: string;
  kind: "not_in_options" | "required" | "invalid";
  message: string;
  rejected?: string[];
  options?: string[];
  didYouMean?: string;
  canAddOption: boolean;
  addOptionRefusal?: string;
}

/** The repair a press sends to `proposals.repair`. */
export interface RepairAct {
  set?: Record<string, string>;
  addOption?: { key: string; value: string };
}

export interface RepairRow {
  key: string;
  label: string;
  /** The value(s) the proposal carries that the field refuses. */
  rejected: string[];
  /** The one-press fix: the allowed value one typo away. */
  suggested?: { value: string; act: RepairAct };
  /** Every other allowed value, to pick from (the suggested one first). */
  choices: string[];
  /** Grow the field with the rejected value (never on a status field). */
  add?: { value: string; act: RepairAct };
  /** The pod's sentence, when there is no value to pick (a required field, a limit). */
  note?: string;
}

/** A field's choice list, capped; the suggested value leads. */
export const REPAIR_CHOICES_CAP = 12;

export function repairRows(fields: RepairOptionsField[]): RepairRow[] {
  return fields.map((f) => {
    const rejected = f.rejected ?? [];
    const options = f.options ?? [];
    const single = rejected.length === 1 ? rejected[0] : undefined;
    const suggested =
      f.didYouMean !== undefined
        ? { value: f.didYouMean, act: { set: { [f.key]: f.didYouMean } } }
        : undefined;
    const choices = [
      ...(suggested ? [suggested.value] : []),
      ...options.filter((o) => o !== suggested?.value),
    ].slice(0, REPAIR_CHOICES_CAP);
    return {
      key: f.key,
      label: f.label,
      rejected,
      ...(suggested ? { suggested } : {}),
      choices: f.kind === "not_in_options" ? choices : [],
      ...(f.canAddOption && single !== undefined
        ? {
            add: {
              value: single,
              act: {
                addOption: { key: f.key, value: single },
                set: { [f.key]: single },
              },
            },
          }
        : {}),
      ...(f.kind !== "not_in_options" || options.length === 0
        ? { note: f.message }
        : {}),
    };
  });
}

/** The act for picking `value` from a row's choices. */
export function pickAct(row: RepairRow, value: string): RepairAct {
  return { set: { [row.key]: value } };
}

/**
 * Where a pod admin reads the exact cause of this failure: the server error
 * the pod recorded for it (`data.failure.errorId`, plan 8032a127 D5), or null.
 * Only for an admin: the cause behind it is read only with pod-admin rights
 * (`system.getServerFault`), so a member would be shown a door that 403s.
 */
export function failureCauseHref(
  data: unknown,
  role: ConsoleRole
): string | null {
  if (role !== "admin") return null;
  const failure = (data as { failure?: unknown } | null | undefined)?.failure;
  const errorId =
    failure && typeof failure === "object"
      ? (failure as { errorId?: unknown }).errorId
      : undefined;
  return typeof errorId === "string" && errorId
    ? serverErrorHref(errorId)
    : null;
}
