import { describe, it, expect } from "vitest";
import {
  CEILING_DEFAULTS,
  DEFAULT_DAILY_WRITE_CEILING,
  WORKER_IRREVERSIBLE_DAILY_CEILING,
} from "@synap/governance-policy";
import { AI_DISPATCH_GUARDRAILS } from "@synap-core/types/automations";
import { DEFAULT_WORKER_MAX_PENDING_APPROVALS } from "@synap-core/types/workers";
import { AGENT_PENDING_PROPOSAL_CAP } from "../utils/permission-check.js";

/**
 * TRIPWIRE — the caps fold (W1c) keeps ONE table of governance-ceiling
 * defaults: `CEILING_DEFAULTS` (@synap/governance-policy), read by
 * `resolveCeiling`. Three published copies remain because their packages
 * cannot import that private one: `AI_DISPATCH_GUARDRAILS` and
 * `DEFAULT_WORKER_MAX_PENDING_APPROVALS` (@synap-core/types, read by the apps
 * and the diagnose surface) and the api's `AGENT_PENDING_PROPOSAL_CAP`.
 * They are MIRRORS: this pins each equal to the fold's value, so changing a
 * default in one place and not the other fails here.
 *
 * Not covered: a new axis — `@synap/database` already fails the BUILD when
 * `CEILING_DEFAULTS` misses an axis (`_CeilingDefaultsCoverAxes`).
 */
describe("tripwire: ceiling defaults have one source", () => {
  it("every published copy equals CEILING_DEFAULTS", () => {
    expect({
      daily_write_count: DEFAULT_DAILY_WRITE_CEILING,
      pending_proposal_cap: AGENT_PENDING_PROPOSAL_CAP,
      automation_ai_dispatch_per_run: AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerRun,
      automation_ai_dispatch_daily:
        AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault,
      worker_pending_approvals: DEFAULT_WORKER_MAX_PENDING_APPROVALS,
      worker_irreversible_sends_daily: WORKER_IRREVERSIBLE_DAILY_CEILING,
    }).toEqual(CEILING_DEFAULTS);
  });
});
