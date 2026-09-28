/**
 * AGENT POSTURES — a NAMED governance preset an operator (or `synap init`)
 * applies to one agent, resolved HERE so no client re-states an action list.
 *
 * A posture is not a second store. Applying one writes ordinary rows into THE
 * store (`governance_rules`, agent-scoped, pod scope — rung 2.8) plus the
 * agent's `writesRequireProposal` dial, through one writer
 * (`applyAgentPosture`, @synap/database). Every floor still outranks it: a
 * rule can never auto-approve a delete, an admin action or a structure write
 * (rungs 2 / 2.5 / 2.09 return first), so a posture cannot either.
 *
 * ── `create-with-undo` (founder decision D2, 2026-09-28) ─────────────────────
 * A NEW agent's default: CREATES auto-approve (each lands with a receipt the
 * person can undo); updates, property-def changes, automations and deletions
 * PROPOSE. Expressed as:
 *   - `writesRequireProposal: false`, so the platform floor
 *     (`DEFAULT_AUTO_APPROVE`, rung 8) auto-approves its creates;
 *   - a `propose` rule for every floor entry that is NOT a create, a read or
 *     session orchestration — DERIVED from the floor, so a write key added to
 *     the floor later is proposed under this posture by existing, never by a
 *     hand list falling behind;
 *   - property defs, automations and deletes need no rule: they are not on the
 *     floor (rung 9 proposes) or are floored above rung 2.8.
 */

import { DEFAULT_AUTO_APPROVE, isPureReadAction } from "./index.js";

export const AGENT_POSTURE_NAMES = ["create-with-undo"] as const;
export type AgentPostureName = (typeof AGENT_POSTURE_NAMES)[number];

/** The posture every NEW BYOA agent starts on (D2). */
export const DEFAULT_NEW_AGENT_POSTURE: AgentPostureName = "create-with-undo";

export interface AgentPosture {
  name: AgentPostureName;
  writesRequireProposal: boolean;
  /** Rung-2.8 `auto` rules (beyond what the floor already grants). */
  autoApproveFor: readonly string[];
  /** Rung-2.8 `propose` rules — floor entries this posture takes back. */
  proposeFor: readonly string[];
}

/** Verbs that bring a thing into existence (or attach an additive role). */
const CREATE_VERBS: ReadonlySet<string> = new Set(["create", "attach"]);

/**
 * Subjects whose writes are the agent's own WORK ORCHESTRATION, not the
 * person's data: opening, staging and progressing a focus session. Proposing
 * them would stall every run on a review of its own progress bar.
 */
const ORCHESTRATION_SUBJECTS: ReadonlySet<string> = new Set(["focus_session"]);

/** How a floor entry is classified under `create-with-undo`. Pure. */
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
        writesRequireProposal: false,
        autoApproveFor: [],
        proposeFor: DEFAULT_AUTO_APPROVE.filter(
          (p) => classifyFloorEntry(p) === "write"
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
