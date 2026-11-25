/**
 * A ledger's stored status → the run feed's word, READ OFF THE DECLARATION
 * (`./playbook-run-status.ts`). Each case names the wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import { SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import { PLAYBOOK_RUN_STATUSES } from "@synap-core/types/units";
import {
  playbookRunStatusesReadingAs,
  runStatusOfPlaybookRun,
  runStatusOfSession,
  sessionStatusesReadingAs,
} from "./playbook-run-status.js";

describe("the run feed reads stale as PAUSED (founder, 2026-11-20)", () => {
  // Rules out the two old readings: "stale = cancelled" (both the session
  // mapper and runStatusOfPlaybookRun) and "paused = running".
  it("a stale or paused session, and a stale playbook run, read paused", () => {
    expect(runStatusOfSession("stale")).toBe("paused");
    expect(runStatusOfSession("paused")).toBe("paused");
    expect(runStatusOfPlaybookRun("stale")).toBe("paused");
  });

  it("every other stored word keeps its reading", () => {
    expect(runStatusOfSession("active")).toBe("running");
    // A planned step (category open) has not started: queued, never running.
    expect(runStatusOfSession("forming")).toBe("queued");
    expect(runStatusOfSession("closed")).toBe("completed");
    expect(runStatusOfSession("failed")).toBe("failed");
    expect(runStatusOfSession("cancelled")).toBe("cancelled");
    for (const s of PLAYBOOK_RUN_STATUSES.filter((s) => s !== "stale")) {
      expect(runStatusOfPlaybookRun(s), s).toBe(s);
    }
  });
});

describe("the status filter is the same rule run backwards", () => {
  // Rules out a hand-written reverse map that drifts from the reading: the
  // old one paired stale with `cancelled`.
  it("paused finds paused and stale; cancelled finds only cancelled", () => {
    expect([...sessionStatusesReadingAs("paused")].sort()).toEqual([
      "paused",
      "stale",
    ]);
    expect(sessionStatusesReadingAs("cancelled")).toEqual(["cancelled"]);
    expect(playbookRunStatusesReadingAs("paused")).toEqual(["stale"]);
    expect(playbookRunStatusesReadingAs("cancelled")).toEqual(["cancelled"]);
  });

  it("every stored status is found by the filter of its own reading (scheduled is never a run)", () => {
    for (const s of SESSION_STATUSES) {
      const found = sessionStatusesReadingAs(runStatusOfSession(s));
      expect(found.includes(s), s).toBe(s !== "scheduled");
    }
    for (const s of PLAYBOOK_RUN_STATUSES) {
      expect(playbookRunStatusesReadingAs(runStatusOfPlaybookRun(s))).toContain(
        s
      );
    }
  });
});
