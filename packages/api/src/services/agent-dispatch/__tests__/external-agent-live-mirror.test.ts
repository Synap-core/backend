/**
 * `@synap-core/types/agents` reads two pod facts: which RUN statuses a cancel
 * can act on (`LIVE_RUN_STATUSES`, now read off the run declaration — the
 * same set the pod's cancel door reads, no longer a mirror) and which task
 * states the pod writes on `playbook_runs.external_agent.status` (still a
 * mirror). Browser and relay offer Cancel and draw the mark from them, so a
 * drift would offer Cancel on a run the pod refuses (CONFLICT), or draw a
 * real state as "unmeasured".
 *
 * Covers: the live set's MEANING (runtime: equal sets would also agree on a
 * wrong one, so the members are pinned), and the status union (compile time —
 * a new pod state fails `tsc` until the mirror lists it).
 */
import { describe, expect, it } from "vitest";
import { LIVE_RUN_STATUSES } from "@synap-core/types/units";
import type { PlaybookRunExternalAgent } from "@synap/database/schema";
import {
  EXTERNAL_AGENT_STATUSES,
  type ExternalAgentStatus,
} from "@synap-core/types/agents";

type PodStatus = PlaybookRunExternalAgent["status"];
type _Same = [PodStatus] extends [ExternalAgentStatus]
  ? [ExternalAgentStatus] extends [PodStatus]
    ? true
    : never
  : never;
const _same: _Same = true;
void _same;

describe("external agent mirror", () => {
  it("the cancellable run statuses are the pod's live run statuses", () => {
    // Live = born and not ended; `proposed` waits for its approved start.
    expect([...LIVE_RUN_STATUSES].sort()).toEqual([
      "blocked",
      "queued",
      "running",
      "stale",
      "waiting_on_you",
    ]);
  });
  it("the status tuple is non-empty (the type floor compares a real set)", () => {
    expect(EXTERNAL_AGENT_STATUSES.length).toBeGreaterThan(3);
  });
});
