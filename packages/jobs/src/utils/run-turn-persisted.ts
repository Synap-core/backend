/**
 * The IoC slot that tells @synap/api a run turn's reply is saved, so the pod
 * judges what the turn did only once the whole turn is in
 * (`settleRunTurnPersisted`, api `run-turn-end.ts`). The IS reports the turn's
 * end without waiting for the pod to save its reply, so the report can arrive
 * first. A slot, not an import: api depends on jobs (see `session-close.ts`).
 * Unfilled, nothing is judged here and the run waits for the reapers.
 */
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "run-turn-persisted" });

export interface RunTurnPersistedInput {
  sessionId: string;
  /** The message that triggered the turn (its `turnKey`). */
  userMessageId: string;
}

type RunTurnPersisted = (input: RunTurnPersistedInput) => Promise<unknown>;

let handler: RunTurnPersisted | null = null;

export function registerRunTurnPersisted(fn: RunTurnPersisted): void {
  handler = fn;
}

/** Never throws: the reply is saved whatever the judgment does. */
export async function runTurnPersisted(
  input: RunTurnPersistedInput
): Promise<void> {
  if (!handler) return;
  try {
    await handler(input);
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId },
      "a saved run turn could not be judged; the reapers will"
    );
  }
}
