/**
 * "What asks for your passkey" (W5, founder 6 Nov 2026: "pod settings (pod
 * admin) should enable the user to select what is considered sensitive &
 * what is not"), derived in one place from the pod's choice
 * (`presence.sensitivity`). Pure, so each state is tested.
 *
 *  - The rows are the pod's own lists (`presenceSensitivityRows`,
 *    `@synap-core/types/presence`), never a copy: a row added there shows
 *    here by existing.
 *  - Grouped by reason, deploys first (the founder's example), then setup,
 *    governance, deletions; inside a group, approvals then actions.
 *  - Named through the one kind-words door the audit lens and the presence
 *    card share (`presenceKindWords`: an approval's proposal title words, an
 *    action's title), never a raw token. A type prefix has no words of its own:
 *    the card says "Any … request" around `humanizeToken`.
 */
import {
  presenceSensitivityRows,
  normalizePresenceSensitivity,
  type PresenceSensitivityChoice,
  type SensitiveReason,
} from "@synap-core/types/presence";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { presenceKindWords } from "../../audit/_lib/presence-missing-link";

/** The order the groups show in. */
export const REASON_ORDER: readonly SensitiveReason[] = [
  "deploy",
  "setup",
  "governance",
  "deletion",
];

/** How many rows a group lists before "Show all". */
export const SENSITIVITY_CAP = 4;

export interface SensitivityRowView {
  kind: "approval" | "action";
  key: string;
  /** The row's words; for a prefix row, the words of the type it starts. */
  label: string;
  prefix: boolean;
  /** It asks for a passkey (not switched off). */
  on: boolean;
}

export interface SensitivityGroupView {
  reason: SensitiveReason;
  total: number;
  /** Rows that still ask. */
  asking: number;
  rows: SensitivityRowView[];
  /** Rows left out of `rows` until "Show all". */
  more: number;
}

export interface SensitivityView {
  groups: SensitivityGroupView[];
  total: number;
  asking: number;
  /** Something is switched off: "Ask for everything again" is offered. */
  anyOff: boolean;
}

function rowLabel(row: {
  kind: "approval" | "action";
  key: string;
  prefix?: true;
}): string {
  // A prefix (`governance.`): the type it starts, without the dot.
  if (row.prefix) return humanizeToken(row.key.replace(/\.$/, ""));
  return presenceKindWords(row.key);
}

export function sensitivityView(
  choice: PresenceSensitivityChoice | null | undefined,
  opts: { expanded?: ReadonlySet<SensitiveReason> } = {}
): SensitivityView {
  const current = normalizePresenceSensitivity(choice);
  const off = {
    approval: new Set(current.approvalsOff),
    action: new Set(current.actionsOff),
  };
  const all = presenceSensitivityRows().map((r) => ({
    reason: r.reason,
    view: {
      kind: r.kind,
      key: r.key,
      label: rowLabel(r),
      prefix: r.prefix === true,
      on: !off[r.kind].has(r.key),
    } satisfies SensitivityRowView,
  }));
  const groups = REASON_ORDER.map((reason) => {
    const inGroup = all
      .filter((r) => r.reason === reason)
      .map((r) => r.view)
      // Approvals first, then actions; each list keeps the pod's order.
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "approval" ? -1 : 1));
    const rows = opts.expanded?.has(reason)
      ? inGroup
      : inGroup.slice(0, SENSITIVITY_CAP);
    return {
      reason,
      total: inGroup.length,
      asking: inGroup.filter((r) => r.on).length,
      rows,
      more: inGroup.length - rows.length,
    };
  }).filter((g) => g.total > 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const asking = groups.reduce((n, g) => n + g.asking, 0);
  return { groups, total, asking, anyOff: asking < total };
}

/** The choice with one row switched on or off. */
export function withRow(
  choice: PresenceSensitivityChoice | null | undefined,
  row: { kind: "approval" | "action"; key: string },
  on: boolean
): PresenceSensitivityChoice {
  const current = normalizePresenceSensitivity(choice);
  const list = row.kind === "approval" ? "approvalsOff" : "actionsOff";
  const next = new Set(current[list]);
  if (on) next.delete(row.key);
  else next.add(row.key);
  return normalizePresenceSensitivity({ ...current, [list]: [...next] });
}
