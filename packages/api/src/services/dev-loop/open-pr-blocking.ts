/**
 * sessionIdsBlockingOpenPr — which sessions hold an OPEN pull request.
 *
 * What a session asks the person is blocking that PR (the plan 2c8fca91 §4
 * "Also"), so the needs-you rule never folds it by age and the order puts it
 * first (`NeedsYouSessionFacts.blocksOpenPr`). No new store: the session's
 * open PR outcomes (`workUnitsSection`) joined to the recorded PR facts
 * (`readPullRequestStates`), the very read the waiting-on uses
 * (`readOpenWorkUnits`). A PR with no recorded fact is never guessed open.
 *
 * Never throws: a failed read is LOGGED and returns the empty set, which is
 * today's rule (the ask ages as before). That is the one place an unmeasured
 * fact reads as "none", chosen so a PR-state outage cannot blank the tray.
 */

import { createLogger } from "@synap-core/core";

import type { WaitingOnReader } from "../status/status-facts.js";

const logger = createLogger({ module: "dev-loop/open-pr-blocking" });

export async function sessionIdsBlockingOpenPr(
  reader: WaitingOnReader,
  sessionIds: readonly string[]
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return new Set();
  try {
    const { readOpenWorkUnits } = await import("../status/status-facts.js");
    const bySession = await readOpenWorkUnits(reader, ids);
    const out = new Set<string>();
    for (const [sessionId, units] of bySession) {
      if (units.some((u) => u.facts.state === "open")) out.add(sessionId);
    }
    return out;
  } catch (error) {
    logger.warn(
      { err: error, sessions: ids.length },
      "open PR read failed; needs-you ages asks by the base rule"
    );
    return new Set();
  }
}
