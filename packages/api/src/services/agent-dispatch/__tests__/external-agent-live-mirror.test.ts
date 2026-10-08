/**
 * `@synap-core/types/agents` mirrors two pod facts its pure leaf cannot import:
 * which RUN statuses a cancel can act on (`LIVE_RUN_STATUSES`) and which task
 * states the pod writes on `playbook_runs.external_agent.status`. Browser and
 * relay offer Cancel and draw the mark from the mirror, so a drift would offer
 * Cancel on a run the pod refuses (CONFLICT), or draw a real state as
 * "unmeasured".
 *
 * Covers: value equality of the live set (runtime), and the status union
 * (compile time — a new pod state fails `tsc` until the mirror lists it).
 */
import { describe, expect, it } from "vitest";
import { LIVE_RUN_STATUSES } from "@synap/database";
import type { PlaybookRunExternalAgent } from "@synap/database/schema";
import {
  EXTERNAL_AGENT_LIVE_RUN_STATUSES,
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
  it("the cancellable run statuses ARE the pod's live run statuses", () => {
    expect([...EXTERNAL_AGENT_LIVE_RUN_STATUSES].sort()).toEqual(
      [...LIVE_RUN_STATUSES].sort()
    );
  });
  it("the status tuple is non-empty (the type floor compares a real set)", () => {
    expect(EXTERNAL_AGENT_STATUSES.length).toBeGreaterThan(3);
  });
});
