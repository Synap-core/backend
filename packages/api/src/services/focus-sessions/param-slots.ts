/**
 * The OWED SLOT a missing required param becomes on a session — ONE shape for
 * every door that mints it on a session row that already exists or is being
 * inserted: `createFocusSession` (a template's params, or a TRACK's method
 * params passed by `startStageSession`) and the `focus_session/create`
 * approval executor (the same track params, re-read at approval).
 *
 * The run funnel (`instantiateSessionRow`) mints its own with run-specific
 * wording ("the run started without it") and is deliberately not folded in.
 */

import type { ExpectedOutput, PlaybookParam } from "@synap/playbooks";
import { PARAM_SLOT_KIND } from "@synap-core/types/focus-sessions";

export function paramOwedSlots(
  missing: readonly PlaybookParam[],
  /** What needs the value — the playbook's or the track's name. */
  sourceName: string,
  owedAt: string
): ExpectedOutput[] {
  return missing.map((p) => ({
    kind: PARAM_SLOT_KIND,
    label: `Answer: ${p.label?.trim() || p.name}`,
    owner: "human" as const,
    blockedReason: "decision" as const,
    why: `"${sourceName}" needs a value for "${p.label?.trim() || p.name}"${
      p.options?.length
        ? ` (one of ${p.options.map((o) => `"${o}"`).join(", ")})`
        : ` (${p.type})`
    }. Nobody supplied it when this session was started.`,
    owedSince: owedAt,
  }));
}
