/**
 * AGENT POSTURES — a NAMED, OPTIONAL, STRICTER-ONLY per-agent preset on top of
 * the pod default, resolved HERE so no client re-states an action list.
 *
 * ONE DECISION PATH. The pod default (founder, 2026-09-28: "reversible writes
 * act") is one `governance_rules` row, pattern `@reversible`, principal any,
 * scope pod (migration 0282, Settings › AI Governance › How agents act). A
 * posture is ordinary agent-scoped rows in THE SAME store, written by ONE
 * writer (`applyAgentPosture`, @synap/database), resolved by the SAME rung 2.8.
 * An agent's own row is more specific than the pod row, so a posture can only
 * say "ask me first" where the pod default would act.
 *
 * NEVER LOOSENS. A posture writes only `propose` rules and pins
 * `writesRequireProposal: true`; it cannot open anything the pod default and
 * the floors keep closed (rules never outrank rungs 2 / 2.05–2.09 / 2.1 / 2.5).
 * New agents get NO posture — they take the pod default.
 *
 * ── `create-with-undo` ──────────────────────────────────────────────────────
 * For an agent the owner wants on a shorter leash: its CREATES (and its own
 * session/run orchestration) keep the pod default's direct lane, every other
 * reversible write — edits, detaches, re-arranges — proposes. DERIVED from the
 * engine's reversibility class, so a reversible door added later is covered by
 * existing, never by a hand list falling behind.
 */

import { REVERSIBLE_EVENT_KEYS, isPureReadAction } from "./index.js";

export const AGENT_POSTURE_NAMES = ["create-with-undo"] as const;
export type AgentPostureName = (typeof AGENT_POSTURE_NAMES)[number];

export interface AgentPosture {
  name: AgentPostureName;
  /** Always `true`: a posture never loosens rung 5. */
  writesRequireProposal: true;
  /** Rung-2.8 `auto` rules — always empty: a posture never widens. */
  autoApproveFor: readonly string[];
  /** Rung-2.8 `propose` rules — pod-default lanes this posture takes back. */
  proposeFor: readonly string[];
}

/** Verbs that bring a thing into existence (or attach an additive role). */
const CREATE_VERBS: ReadonlySet<string> = new Set(["create", "attach"]);

/**
 * Subjects whose writes are the agent's own WORK ORCHESTRATION, not the
 * person's data: a focus session, a playbook run, a track's progress.
 * Proposing them would stall every run on a review of its own progress bar.
 */
const ORCHESTRATION_SUBJECTS: ReadonlySet<string> = new Set([
  "focus_session",
  "playbook_run",
  "track",
]);

/** How an event key is classified by the presets. Pure. */
export function classifyFloorEntry(
  pattern: string
): "read" | "create" | "orchestration" | "write" {
  const dot = pattern.indexOf(".");
  const subject = dot === -1 ? pattern : pattern.slice(0, dot);
  const action = dot === -1 ? "" : pattern.slice(dot + 1);
  if (isPureReadAction(subject, action, pattern) || action.startsWith("read"))
    return "read";
  if (ORCHESTRATION_SUBJECTS.has(subject)) return "orchestration";
  if (CREATE_VERBS.has(action)) return "create";
  return "write";
}

export function resolveAgentPosture(name: AgentPostureName): AgentPosture {
  switch (name) {
    case "create-with-undo":
      return {
        name,
        writesRequireProposal: true,
        autoApproveFor: [],
        proposeFor: REVERSIBLE_EVENT_KEYS.filter(
          (k) => classifyFloorEntry(k) === "write"
        ),
      };
  }
}

export function isAgentPostureName(v: unknown): v is AgentPostureName {
  return (
    typeof v === "string" &&
    (AGENT_POSTURE_NAMES as readonly string[]).includes(v)
  );
}
