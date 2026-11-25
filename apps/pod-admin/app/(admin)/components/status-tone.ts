/**
 * Every semantic tone the console meets → `StatusPill`'s four kinds, in one
 * place, so "amber" means the same thing on every page.
 *
 *   • stored status words (`statusPillFor`) — the meaning comes from
 *     `@synap-core/types/property-render` (`getEnumTone`, the same rule
 *     app-bases chips paint from), the words from the vocabulary
 *     (`resolveStatusLabel`);
 *   • an agent's mark (`AGENT_MARK_STATUS`, `@synap-core/types/agents`);
 *   • the pod's health roll-up (`HEALTH_PILL`, `diagnose.global`);
 *   • a shared unit tone (`unitTonePill`, `@synap-core/types/units`
 *     `resolveUnitState`: a goal's mark, a process's health).
 *
 * Never a second status table — only the mapping onto the pill.
 */

import type { AgentMarkTone } from "@synap-core/types/agents";
import type { UnitTone } from "@synap-core/types/units";
import { getEnumTone, type EnumTone } from "@synap-core/types/property-render";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import type { HealthStatus } from "../home/_lib/needs-you";
import type { StatusKind } from "./status-pill";

/**
 * `active` is healthy on purpose: for the objects the console shows (a rule
 * that is on, a session in motion) "running" is the good state. `pending`
 * reads amber — awaiting a look — which is what `stale` means on the pill.
 */
const PILL_KIND: Record<EnumTone, StatusKind> = {
  positive: "healthy",
  active: "healthy",
  pending: "stale",
  negative: "down",
  neutral: "unknown",
};

export function statusKindForTone(tone: EnumTone): StatusKind {
  return PILL_KIND[tone];
}

/** Pill props for a raw status value, or null when there is none to show. */
export function statusPillFor(
  value: string | null | undefined
): { kind: StatusKind; label: string } | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  return {
    kind: statusKindForTone(getEnumTone(raw)),
    label: resolveStatusLabel(raw),
  };
}

export const AGENT_MARK_STATUS: Record<AgentMarkTone, StatusKind> = {
  success: "healthy",
  warning: "stale",
  danger: "down",
  neutral: "unknown",
};

/** The status line's pill, and a degraded "Needs you" row's. */
export const HEALTH_PILL: Record<
  HealthStatus,
  { kind: StatusKind; label: string }
> = {
  ok: { kind: "healthy", label: "All good" },
  attention: { kind: "stale", label: "Worth a look" },
  degraded: { kind: "down", label: "Act now" },
};

/**
 * A unit tone as a console pill. The console has four pill kinds; a mark's
 * tone is the shared unit tone. A quiet tone (closed as retired, dropped,
 * never started) reads as `unknown` (grey), never as healthy.
 *
 * `primary` is the "your turn" tone (`resolveUnitState`: waiting on you, a
 * check gate holding for a person, a process blocked by policy): it reads
 * `stale`, the pill that means "awaiting a look", never the healthy one
 * (Process wave W4: "Waiting on you" drawn green was a defect, on goals too).
 * `ai` (running) stays `healthy`: the console has no kind of its own for
 * work in motion, and "running" is its good state (`PILL_KIND` above).
 */
const PILL_FOR_UNIT_TONE: Record<UnitTone, StatusKind> = {
  primary: "stale",
  ai: "healthy",
  info: "healthy",
  success: "healthy",
  warning: "stale",
  error: "down",
  textSecondary: "unknown",
  textMuted: "unknown",
};

export function unitTonePill(tone: UnitTone): StatusKind {
  return PILL_FOR_UNIT_TONE[tone] ?? "unknown";
}
