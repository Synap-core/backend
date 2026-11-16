/**
 * The pure half of pod admin's process pages (`/processes`, `/processes/[id]`,
 * `/open/playbook/:id`): which blocks draw and in what order, the week's
 * counts as doors, the pre-approval and provenance lines, a need's and a
 * step's row. The pages only fetch, translate (`./copy`) and draw.
 *
 * Nothing here decides what a process IS: the block order, the "empty"
 * answer and the health come from `@synap-core/types/processes`, the one
 * leaf the desktop reads too (Process wave plan 0adf8352, W4; held by
 * `packages/types/src/processes/pod-admin-one-rule.tripwire.test.ts`). Pod
 * admin shows the definition and the COUNTS of its runs; each count is a
 * door to the desktop, where runs are worked (decision D4: no run list here).
 */

import {
  PROCESS_BLOCKS,
  processBlockIsEmpty,
  processHealthUnitInput,
  type ProcessHealth,
  type ProcessBlock,
  type ProcessDefinition,
  type ProcessNeed,
  type ProcessRead,
  type ProcessRunCounts,
  type ProcessStep,
} from "@synap-core/types/processes";
import { resolveUnitState, trackStepGateLabel } from "@synap-core/types/units";
import type { Locale } from "@synap-core/types/i18n";
import {
  humanizeToken,
  resolveProcessHealthLabel,
  resolveStepRunnerLabel,
} from "@synap-core/types/vocabulary";
import type { ExitTarget } from "../../../../lib/open-in";
import type { StatusKind } from "../../components/status-pill";
import { unitTonePill } from "../../components/status-tone";
import type { en } from "./copy";

type Key = keyof typeof en;

/** A message to translate: a catalog key and its params. */
export interface Words {
  key: Key;
  params?: Record<string, string | number>;
}

/**
 * The blocks pod admin draws, in the leaf's order. An empty block is OMITTED;
 * a block whose read failed is kept (the leaf never calls it empty) so the
 * page can explain it. `runs` is never a block here (D4): its counts head the
 * page as doors to the desktop.
 */
export function blocksToDraw(read: ProcessRead): ProcessBlock[] {
  return PROCESS_BLOCKS.filter(
    (block) => block !== "runs" && !processBlockIsEmpty(read, block)
  );
}

/** Whether a block's read failed (its section explains instead of listing). */
export function blockUnavailable(
  read: Pick<ProcessRead, "unavailable">,
  block: ProcessBlock
): boolean {
  return (read.unavailable as readonly string[]).includes(block);
}

export type CountKey = "needsYou" | "failedThisWeek" | "open" | "doneThisWeek";

export interface CountDoor {
  key: CountKey;
  n: number;
  words: Words;
  tone: StatusKind;
}

/** What needs a person comes first, what was already done last. */
const COUNT_ORDER: ReadonlyArray<{ key: CountKey; tone: StatusKind }> = [
  { key: "needsYou", tone: "stale" },
  { key: "failedThisWeek", tone: "down" },
  { key: "open", tone: "healthy" },
  { key: "doneThisWeek", tone: "unknown" },
];

/**
 * The week's counts a page shows, each a door. A count of 0 is omitted (an
 * empty slot reads "nothing there"); an UNMEASURED count (`null`) is never
 * read as 0: `unmeasured` says some count could not be read.
 */
export function countDoors(counts: ProcessRunCounts): {
  doors: CountDoor[];
  unmeasured: boolean;
} {
  const doors: CountDoor[] = [];
  let unmeasured = false;
  for (const { key, tone } of COUNT_ORDER) {
    const n = counts[key];
    if (n === null) {
      unmeasured = true;
      continue;
    }
    if (n > 0)
      doors.push({
        key,
        n,
        tone,
        words: { key: `count.${key}`, params: { n } },
      });
  }
  return { doors, unmeasured };
}

/**
 * Who may start it without asking (0420: one version, the person's agents).
 * A failed read of that permission (`unavailable` names `preApproval`) says
 * so: it never falls back to "your agents ask you", which would be a guess.
 */
export function preApprovalWords(
  def: Pick<ProcessDefinition, "version" | "preApprovedVersion">,
  read: Pick<ProcessRead, "unavailable">
): Words {
  if ((read.unavailable as readonly string[]).includes("preApproval")) {
    return { key: "access.unavailable" };
  }
  if (def.preApprovedVersion === null) return { key: "access.none" };
  if (def.preApprovedVersion === def.version) {
    return { key: "access.allowed", params: { version: def.version } };
  }
  return {
    key: "access.outdated",
    params: { allowed: def.preApprovedVersion },
  };
}

/** Where the definition came from. */
export function installedFromWords(
  def: Pick<ProcessDefinition, "installedFrom">
): Words {
  const from = def.installedFrom;
  if (!from) return { key: "installed.local" };
  const name = humanizeToken(from.packageSlug);
  return from.packageVersion
    ? {
        key: "installed.package",
        params: { name, version: from.packageVersion },
      }
    : { key: "installed.packageOnly", params: { name } };
}

/** A need as a row: its name, and who fills it when it is filled. */
export function needRow(need: ProcessNeed): {
  label: string;
  provider: string | null;
  state: ProcessNeed["state"];
} {
  const named = need.providers.find((p) => p.capabilityName)?.capabilityName;
  const verb = need.providers.find((p) => p.verbId)?.verbId;
  return {
    label: humanizeToken(need.slug),
    provider:
      need.state === "filled"
        ? (named ?? (verb ? humanizeToken(verb) : null))
        : null,
    state: need.state,
  };
}

/** What a step may use, in words; null when it uses the process's own list. */
export function stepUses(
  step: Pick<ProcessStep, "tools" | "requires">
): string | null {
  const all = [...step.tools, ...step.requires];
  return all.length === 0 ? null : all.map((t) => humanizeToken(t)).join(", ");
}

/**
 * A process's health as a console pill: the leaf's ONE tone
 * (`processHealthUnitInput` through `resolveUnitState`, the desktop's mark
 * too) on pod admin's unit-tone map, and the words of its reason code from
 * the vocabulary door (`resolveProcessHealthLabel`).
 */
export function processHealthPill(
  health: Pick<ProcessHealth, "state" | "reason">,
  locale: Locale
): { kind: StatusKind; label: string } {
  return {
    kind: unitTonePill(resolveUnitState(processHealthUnitInput(health)).tone),
    label: resolveProcessHealthLabel(health, { locale }),
  };
}

/**
 * Who moves a step on, in the vocabulary's word (`resolveStepRunnerLabel`
 * over the read's `runnerKind`, which the pod classifies once with the leaf's
 * `classifyStepRunner`; the desktop's legend too): "You" or "An agent". A
 * label on its own, never cased into a sentence; the step's gate is its own
 * badge (`stepGateLabel`).
 */
export function runnerLabel(
  step: Pick<ProcessStep, "runnerKind">,
  locale: Locale
): string {
  return resolveStepRunnerLabel(step.runnerKind, { locale });
}

/**
 * A step's gate as its own badge, in the one door's words
 * (`trackStepGateLabel`, `@synap-core/types/units`, the desktop's badge too):
 * null when the step has no gate the door names (`awaits` included).
 */
export function stepGateLabel(step: Pick<ProcessStep, "gate">): string | null {
  // The door takes the gate kinds it names and answers null for any other.
  return trackStepGateLabel(
    step.gate as Parameters<typeof trackStepGateLabel>[0]
  );
}

/**
 * Where a count opens, on the desktop (decision D4; the desktop process page
 * reads `?facet=`, lane L4a): what needs you opens the waiting session itself
 * when the health names one (the leaf sets `health.sessionId` only for
 * `waiting-on-you`), else the process; every other count opens the
 * process's activity (its sessions and runs).
 */
export function countExitTarget(
  key: CountKey,
  processId: string,
  health: Pick<ProcessHealth, "sessionId">
): ExitTarget {
  if (key === "needsYou") {
    return health.sessionId
      ? { kind: "objectInApp", objectKind: "session", id: health.sessionId }
      : { kind: "objectInApp", objectKind: "playbook", id: processId };
  }
  return {
    kind: "objectInApp",
    objectKind: "playbook",
    id: processId,
    params: { facet: "activity" },
  };
}
