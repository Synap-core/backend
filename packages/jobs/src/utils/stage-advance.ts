/**
 * The IoC slot that reaches the ONE stage-advance door (`advanceSessionStage`,
 * @synap/api) from @synap/jobs.
 *
 * ── WHY A SLOT AND NOT AN IMPORT ────────────────────────────────────────────
 * `@synap/api` depends on `@synap/jobs` (api/package.json), so jobs can never
 * statically import api — the same circular dep documented on
 * `registerSessionCloser` (utils/session-close.ts) and `registerPlaybookRunner`
 * (workers/capability-dispatch.ts). apps/api is the one place that may import
 * both and fills this slot at boot. No HTTP, no shared secret.
 *
 * ── WHY IT EXISTS AT ALL ────────────────────────────────────────────────────
 * A playbook stage may declare `gate: { kind: "human" }`. The automation
 * `session_update` output wrote `focus_sessions.current_stage` with a raw UPDATE
 * plus a hand-copied `stage_changed` emit, and resolved no gate at all — an
 * automation could advance a run straight through an approval a human was
 * supposed to give. Copying the gate into this package would BE the
 * hand-maintained-projection defect a fourth time, so this is the inversion.
 *
 * ── FAIL-CLOSED ─────────────────────────────────────────────────────────────
 * Unfilled, this slot THROWS. That is deliberate and is the opposite of the
 * usual "log and skip": an unresolved gate is indistinguishable from an ungated
 * stage, so skipping would silently walk exactly the approval the door exists to
 * enforce. A boot that failed to register is a misconfiguration, and the honest
 * answer is a failed step the automation run records — not a quiet advance.
 */

/**
 * Structural mirror of api's `StageAdvanceSession` (no import — cycle). Field
 * names and nullability match exactly, so apps/api registers the real door with
 * NO cast; a drift in either shape is a compile error at the registration site.
 */
export interface StageAdvanceSessionRow {
  id: string;
  currentStage: string | null;
  workspaceId: string | null;
  projectId: string | null;
  channelId: string | null;
  playbookId: string | null;
  subjectEntityId: string | null;
}

export interface StageAdvanceRequest {
  session: StageAdvanceSessionRow;
  toStage: string;
  userId: string;
  agentUserId?: string | null;
  /** "door" — nobody wrote the column yet, the door issues the UPDATE. */
  stageWrite: "caller" | "door";
}

export interface StageAdvanceOutcome {
  changed: boolean;
  gated: boolean;
  paused: boolean;
  proposalId?: string;
  proposalType?: string;
}

type StageAdvancer = (
  input: StageAdvanceRequest
) => Promise<StageAdvanceOutcome>;

let stageAdvancer: StageAdvancer | null = null;

export function registerStageAdvancer(fn: StageAdvancer): void {
  stageAdvancer = fn;
}

/** Test/boot introspection — is the door reachable from this process? */
export function isStageAdvancerRegistered(): boolean {
  return stageAdvancer !== null;
}

/**
 * Advance a session's stage through the ONE door. Throws when the slot is
 * unfilled — see FAIL-CLOSED above.
 */
export async function advanceSessionStageViaSlot(
  input: StageAdvanceRequest
): Promise<StageAdvanceOutcome> {
  if (!stageAdvancer) {
    throw new Error(
      "stage advancer unregistered — refusing to advance a focus session's stage " +
        "without resolving its human gate (apps/api fills this slot at boot)"
    );
  }
  return stageAdvancer(input);
}
