/**
 * WHERE A STAGED RUN STANDS — the stages it has not reached yet. PURE, read by
 * the turn end (`run-turn-end.ts`: a completed turn of a run with stages left
 * is a STOP, never the run's completion) and by the next move of a session
 * that ended before its last stage (`continuation-packet.ts`, "Stopped at …").
 *
 * THE DEFECT (session 12dbd086, plan 7d71ddcc wave 0): a Produce Content run
 * (brief → script → draft → review → schedule → publish) did ONE turn that
 * reported `completed` while it still stood on `brief`. The turn end completed
 * the run, the hourly sweep closed its session, and its next move read
 * "Nothing waiting". Any completed turn completed a staged run, however many
 * stages remained.
 *
 * THE PREDICATE, and why it is this one. `focus_sessions.current_stage` is THE
 * stage the run stands on: seeded with `stages[0]` at birth and moved only
 * through the advance doors (`advance-stage.ts`). A run has finished its
 * process when it stands on its LAST declared stage, so it has stages left
 * iff its current stage is not the last declared key. An unset or unknown
 * current stage cannot prove the run got anywhere: it reads as standing
 * before the first stage (every stage left), the same reading
 * `stageEndAskCandidates` uses. `stage_history` is not read: it records what
 * was ENTERED, and a stage entered and left again (a check gate's `onFail`
 * return) is not where the run stands.
 */

/** A declared stage, as the room names it. */
export interface StageRef {
  key: string;
  /** The stage's `name`, else its key. */
  name: string;
}

/** The stages a run has not reached: where it stands, and what follows. */
export interface StagesLeft {
  /** The stage it stands on; `null` when unset or not declared. */
  at: StageRef | null;
  /** The declared stages after it, in order. Never empty. */
  left: StageRef[];
}

function stageRefs(stages: unknown): StageRef[] {
  if (!Array.isArray(stages)) return [];
  const out: StageRef[] = [];
  for (const s of stages) {
    if (!s || typeof s !== "object") continue;
    const key = (s as { key?: unknown }).key;
    if (typeof key !== "string" || !key) continue;
    const name = (s as { name?: unknown }).name;
    out.push({
      key,
      name: typeof name === "string" && name.trim() ? name.trim() : key,
    });
  }
  return out;
}

/**
 * PURE. The stages the run has not reached. `null` = nothing left: no
 * declared stages, or the current stage is the LAST declared one.
 */
export function stagesLeft(
  stages: unknown,
  currentStage: string | null | undefined
): StagesLeft | null {
  const list = stageRefs(stages);
  if (list.length === 0) return null;
  const i = currentStage ? list.findIndex((s) => s.key === currentStage) : -1;
  if (i === list.length - 1) return null;
  return { at: i >= 0 ? list[i]! : null, left: list.slice(i + 1) };
}

/** "at Script", or "before Brief" when it stands on no declared stage. */
export function stoppedWhere(s: StagesLeft): string {
  return s.at ? `at ${s.at.name}` : `before ${s.left[0]!.name}`;
}

/** "3 stages left", "1 stage left". */
export function stagesLeftWords(s: StagesLeft): string {
  return `${s.left.length} stage${s.left.length === 1 ? "" : "s"} left`;
}
