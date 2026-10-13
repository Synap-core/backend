/**
 * Marketplace › Installed and › Tools — what is installed on the pod, whether
 * it works, and which of its verbs are turned on.
 *
 * PURE: rows are shaped here from two reads and tested at the seam.
 *   • `capabilities.compositions` — one per installed capability container:
 *     members (+ wired), health rolled up over its flows, gaps.
 *   • `capabilities.catalog` — the same containers as cards, whose
 *     `verbs[].enabled` is the backing skill's `approved` flag.
 *
 * WHY VERBS AND NOT THE CONTAINER'S `approved` (decision D5): the execution
 * gate (`gateCapabilityExecution`, packages/capability-gate) reads the VERB's
 * row — `skills.approved` / `tools.approved`. The container's own
 * `capabilities.approved` is read by no execution path, only by reports, so an
 * "Approve" here would change nothing a run sees. "Turned on" is the verb.
 */

import type { StatusKind } from "../../components/status-pill";

/** The part of a `capabilities.compositions` element a row reads. */
export interface CompositionLike {
  id: string;
  name: string;
  description: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  members: ReadonlyArray<{ kind: string; wired: boolean }>;
  health: {
    status: "ok" | "degraded" | "failed" | "unknown";
    failedRuns: number;
    stuckRuns: number;
    lastRunAt?: string;
  };
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
  source: "installed" | "available";
  builtIn?: true;
  verbs: readonly CardVerbLike[];
}

export interface InstalledRow {
  id: string;
  name: string;
  /** "Builder" or "Whole pod". */
  where: string;
  verbsOn: number;
  verbsTotal: number;
  /** null when the catalog read failed — unknown, never "0 off". */
  verbsOff: number | null;
  wired: number;
  members: number;
  pill: { kind: StatusKind; label: string };
  /** One sentence naming what is broken in its wiring, or null. */
  gapsLine: string | null;
  lastRunAt: string | null;
}

/** "Whole pod" for a pod-wide container; the space name when it has one. */
export function whereOfCapability(c: {
  workspaceId?: string | null;
  workspaceName?: string | null;
}): string {
  if (!c.workspaceId) return "Whole pod";
  return c.workspaceName ?? "A space";
}

function n(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one pill: a failing flow first (it is breaking now), then verbs that
 * are off (every call to one is refused), then stuck runs, then the quiet
 * states. Healthy is green only when runs say so.
 */
export function capabilityPill(
  health: CompositionLike["health"],
  verbsOff: number | null
): { kind: StatusKind; label: string } {
  if (health.status === "failed")
    return { kind: "down", label: n(health.failedRuns, "failed run") };
  if (verbsOff !== null && verbsOff > 0)
    return { kind: "stale", label: `${n(verbsOff, "tool")} turned off` };
  if (health.status === "degraded")
    return { kind: "stale", label: n(health.stuckRuns, "stuck run") };
  if (health.status === "ok") return { kind: "healthy", label: "Healthy" };
  return { kind: "unknown", label: "No runs yet" };
}

export function gapsLine(gaps: readonly string[]): string | null {
  if (gaps.length === 0) return null;
  return gaps.length === 1
    ? `${gaps[0]}.`
    : `${gaps[0]}, and ${n(gaps.length - 1, "more gap")}.`;
}

/**
 * One row per installed container. `cards` may be null (catalog read failed
 * or still loading): the verb counts are then unknown rather than zero.
 * Ordered by what needs a look first: failing, verbs off, stuck, the rest by
 * name.
 */
export function installedRows(
  compositions: readonly CompositionLike[],
  cards: readonly CardLike[] | null
): InstalledRow[] {
  const verbsById = new Map<string, readonly CardVerbLike[]>();
  for (const c of cards ?? []) if (c.id) verbsById.set(c.id, c.verbs);
  const rows = compositions.map((c): InstalledRow => {
    const verbs = verbsById.get(c.id);
    const verbsOn = verbs?.filter((v) => v.enabled).length ?? 0;
    const verbsTotal = verbs?.length ?? 0;
    const verbsOff = cards === null ? null : verbsTotal - verbsOn;
    return {
      id: c.id,
      name: c.name,
      where: whereOfCapability(c),
      verbsOn,
      verbsTotal,
      verbsOff,
      wired: c.members.filter((m) => m.wired).length,
      members: c.members.length,
      pill: capabilityPill(c.health, verbsOff),
      gapsLine: gapsLine(c.gaps),
      lastRunAt: c.health.lastRunAt ?? null,
    };
  });
  const rank = (r: InstalledRow) =>
    r.pill.kind === "down" ? 0 : r.pill.kind === "stale" ? 1 : 2;
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
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

/** "4 tools turned off in 2 capabilities" / "Every installed tool is turned on." */
export function toolsSummary(groups: readonly ToolGroup[]): string {
  const off = groups.reduce((sum, g) => sum + g.off, 0);
  if (off === 0) return "Every installed tool is turned on.";
  const caps = groups.filter((g) => g.off > 0).length;
  return `${n(off, "tool")} turned off in ${n(caps, "capability", "capabilities")}. Anything that calls one is refused until it is turned on.`;
}
