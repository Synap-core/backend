import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the scheduled playbook-run path does NOT fork the IS kickoff.
 *
 * `executePlaybookRun` (automation-executor.ts) used to INLINE the A2AI trigger
 * enqueue (`getBoss().send(A2AI_TRIGGER_QUEUE, …)`), hardcoding the is-agent flow
 * and bypassing `triggerAutoRespond` (the ONE door) + the executor spine — so a
 * scheduled `external-agent`/`hybrid` playbook silently ran as is-agent. Wave 5
 * collapsed that fork by delegating to api's `runPlaybook` through the
 * `registerPlaybookRunner` IoC slot, whose is-agent executor uses the ONE door.
 *
 * This keeps it that way: automation-executor.ts — the file that owned the fork —
 * may not name the A2AI trigger queue again. (@synap/jobs legitimately names the
 * queue in `a2ai-response-trigger.ts` (the definer/consumer) and the barrels, so
 * this is scoped to the one file, mirroring the api-side a2ai-one-door tripwire
 * which the cross-package scan cannot cover without allowlisting those producers.)
 *
 * If this fails: dispatch the playbook via `playbookRunner({...})` (which routes
 * through runPlaybook → IsAgentExecutor → triggerAutoRespond) instead of
 * enqueuing the A2AI job yourself.
 */

// The tokens that mean "I am enqueuing the IS trigger directly".
const BANNED = ["A2AI_TRIGGER_QUEUE", "a2ai-response-trigger"];

describe("tripwire: scheduled playbook-run uses the IS one-door (no inline A2AI enqueue)", () => {
  it("automation-executor.ts does not name the A2AI trigger queue", () => {
    const file = join(__dirname, "..", "automation-executor.ts");
    const src = readFileSync(file, "utf8");
    const offenders = BANNED.filter((token) => src.includes(token));
    expect(offenders).toEqual([]);
  });
});
