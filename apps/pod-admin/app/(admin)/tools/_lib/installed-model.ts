/**
 * The shapes the Tools list and a capability's page read from the two
 * capability reads, and a capability's actions as its page lists them.
 *
 * PURE: shaped here, tested at the seam.
 *   • `capabilities.compositions` — one per installed capability container:
 *     members (+ wired), health rolled up over its flows, gaps.
 *   • `capabilities.catalog` — the same containers as cards, whose
 *     `verbs[].enabled` is the backing skill's `approved` flag.
 *
 * WHY VERBS AND NOT THE CONTAINER'S `approved` (decision D5): the execution
 * gate (`gateCapabilityExecution`, packages/capability-gate) reads the VERB's
 * row — `skills.approved` / `tools.approved`. The container's own
 * `capabilities.approved` is read by no execution path, only by reports, so an
 * "Approve" would change nothing a run sees. "Turned on" is the verb. The one
 * status mark lives in `tool-status.ts`.
 */

import type { CapabilityCardStatus, RunHealth } from "./tool-status";

/** The part of a `capabilities.compositions` element a row reads. */
export interface CompositionLike {
  id: string;
  name: string;
  description: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  /** Its parts: tools, skills (its actions), playbooks, automations. */
  members: ReadonlyArray<{
    kind: string;
    id: string;
    name?: string;
    wired: boolean;
  }>;
  health: RunHealth & { lastRunAt?: string };
  gaps: readonly string[];
}

export interface CardVerbLike {
  verbId: string;
  skillId: string | null;
  label: string;
  description?: string | null;
  type: "read" | "write" | "action";
  enabled: boolean;
}

/** The part of a `capabilities.catalog` card the tabs read. */
export interface CardLike {
  id: string | null;
  name: string;
  status: CapabilityCardStatus;
  source: "installed" | "available";
  builtIn?: true;
  verbs: readonly CardVerbLike[];
  /**
   * Its member tool rows the run gate refuses (`CapabilityCard.toolsOff`):
   * its ACCESS to the service is off, so no action runs whatever the
   * actions say. Absent when none is (or from an older pod).
   */
  toolsOff?: ReadonlyArray<{ id: string; name: string }>;
}

export interface ToolGroup {
  id: string;
  name: string;
  builtIn: boolean;
  verbs: CardVerbLike[];
  off: number;
}

/**
 * Installed cards → one group per container, verbs that are off first, groups
 * with any verb off first. A verb with no backing skill cannot be toggled and
 * is left out (an available-only template has none; an installed card always
 * carries its skill ids).
 */
export function toolGroups(cards: readonly CardLike[]): ToolGroup[] {
  return cards
    .filter(
      (c): c is CardLike & { id: string } =>
        c.source === "installed" && c.id !== null
    )
    .map((c) => {
      const verbs = c.verbs
        .filter((v) => v.skillId !== null)
        .slice()
        .sort(
          (a, b) =>
            Number(a.enabled) - Number(b.enabled) ||
            a.label.localeCompare(b.label)
        );
      return {
        id: c.id,
        name: c.name,
        builtIn: c.builtIn === true,
        verbs,
        off: verbs.filter((v) => !v.enabled).length,
      };
    })
    .filter((g) => g.verbs.length > 0)
    .sort(
      (a, b) =>
        Number(b.off > 0) - Number(a.off > 0) || a.name.localeCompare(b.name)
    );
}
