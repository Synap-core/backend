/**
 * "A run in flight on this subject" is ONE set, spelled twice: the run spine's
 * subject reuse (`IDEMPOTENCY_NON_REUSABLE_SESSION_STATUSES`, run-playbook.ts)
 * and the propose-mode check before a rule files a run proposal
 * (`RUN_NOT_IN_FLIGHT_SESSION_STATUSES`, @synap/jobs `utils/run-in-flight.ts`,
 * which cannot import this package). If they drifted, a rule could file a
 * run proposal for a subject the spine would have reused, or the reverse.
 */
import { describe, it, expect } from "vitest";
import { RUN_NOT_IN_FLIGHT_SESSION_STATUSES } from "@synap/jobs/utils/run-in-flight.js";
import { IDEMPOTENCY_NON_REUSABLE_SESSION_STATUSES } from "./run-playbook.js";

describe("run in flight — one set for the run spine and the propose check", () => {
  it("the statuses that are NOT a run in flight are the same", () => {
    expect([...RUN_NOT_IN_FLIGHT_SESSION_STATUSES].sort()).toEqual(
      [...IDEMPOTENCY_NON_REUSABLE_SESSION_STATUSES].sort()
    );
  });
});
