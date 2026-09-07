import { describe, it, expect } from "vitest";
import {
  deriveForceProposeWrites,
  buildRunSessionMetadata,
  buildDefinitionSnapshot,
  IDEMPOTENCY_TERMINAL_SESSION_STATUSES,
  type RunChainContext,
} from "./run-playbook.js";
import type { Playbook } from "@synap/database/schema";

/**
 * These cover the LOAD-BEARING semantics ported from the (now-deleted) jobs-local
 * executePlaybookRun into the ONE spine (runPlaybook): the propose-only
 * governance stamp, the automation chain-context stamp, and the run
 * definitionSnapshot. Dropping any of them = auto-executing writes / a broken
 * depth floor / an un-diffable run, so they are pinned here as pure assertions.
 */

describe("deriveForceProposeWrites (propose-only governance stamp)", () => {
  it("is true only when metadata.governance.forceProposeWrites === true", () => {
    expect(
      deriveForceProposeWrites({ governance: { forceProposeWrites: true } })
    ).toBe(true);
  });

  it("is false for absent / falsy / non-boolean governance", () => {
    expect(deriveForceProposeWrites(null)).toBe(false);
    expect(deriveForceProposeWrites(undefined)).toBe(false);
    expect(deriveForceProposeWrites({})).toBe(false);
    expect(deriveForceProposeWrites({ governance: {} })).toBe(false);
    expect(
      deriveForceProposeWrites({ governance: { forceProposeWrites: false } })
    ).toBe(false);
    // A truthy-but-not-true value must NOT enable it (mirrors the old `=== true`).
    expect(
      deriveForceProposeWrites({ governance: { forceProposeWrites: "yes" } })
    ).toBe(false);
  });
});

describe("buildRunSessionMetadata (session metadata stamps)", () => {
  const chain: RunChainContext = {
    automationRunId: "run-1",
    automationId: "auto-1",
    chainDepth: 2,
    rootRunId: "root-1",
    chainAutomationIds: ["auto-1"],
  };

  it("stamps governance when forceProposeWrites is set", () => {
    expect(buildRunSessionMetadata({ forceProposeWrites: true })).toEqual({
      governance: { forceProposeWrites: true },
    });
  });

  it("stamps the automation chain context (F2 depth floor) when provided", () => {
    const meta = buildRunSessionMetadata({
      chainContext: chain,
      forceProposeWrites: false,
    });
    expect(meta).toEqual({
      automationId: "auto-1",
      automationRunId: "run-1",
      automationChainContext: {
        automationRunId: "run-1",
        automationId: "auto-1",
        chainDepth: 2,
        rootRunId: "root-1",
        chainAutomationIds: ["auto-1"],
      },
    });
  });

  it("ALSO stamps automationId/automationRunId TOP-LEVEL — the filter `session-kind.ts` reads", () => {
    // `sessionAutomationWhere`/`AUTOMATION_KEYS` read only the top-level keys,
    // not `automationChainContext` (a different consumer's shape). Without
    // this, a playbook_run session opened from a scheduled automation was
    // invisible to that automation's "run sessions" filter even though its
    // kind still correctly derived as `run` via origin/playbookId.
    const meta = buildRunSessionMetadata({
      chainContext: chain,
      forceProposeWrites: false,
    });
    expect(meta.automationId).toBe("auto-1");
    expect(meta.automationRunId).toBe("run-1");
  });

  it("defaults chainDepth/rootRunId/chainAutomationIds like the old jobs stamp", () => {
    const meta = buildRunSessionMetadata({
      chainContext: {
        automationRunId: "run-9",
        automationId: "auto-9",
      } as RunChainContext,
      forceProposeWrites: false,
    });
    expect(meta).toEqual({
      automationId: "auto-9",
      automationRunId: "run-9",
      automationChainContext: {
        automationRunId: "run-9",
        automationId: "auto-9",
        chainDepth: 0,
        rootRunId: "run-9",
        chainAutomationIds: [],
      },
    });
  });

  it("carries BOTH stamps together and is empty when neither applies", () => {
    expect(
      buildRunSessionMetadata({ chainContext: chain, forceProposeWrites: true })
    ).toEqual({
      automationId: "auto-1",
      automationRunId: "run-1",
      automationChainContext: {
        automationRunId: "run-1",
        automationId: "auto-1",
        chainDepth: 2,
        rootRunId: "root-1",
        chainAutomationIds: ["auto-1"],
      },
      governance: { forceProposeWrites: true },
    });
    expect(buildRunSessionMetadata({ forceProposeWrites: false })).toEqual({});
  });
});

describe("buildDefinitionSnapshot (D3c run snapshot)", () => {
  it("snapshots version/goalTemplate/stages/params/expectedOutputs", () => {
    const playbook = {
      version: 3,
      goalTemplate: "Do {{x}}",
      stages: [{ key: "s1" }],
      params: [{ name: "x" }],
      expectedOutputs: [{ label: "out" }],
    } as unknown as Playbook;
    expect(buildDefinitionSnapshot(playbook)).toEqual({
      version: 3,
      goalTemplate: "Do {{x}}",
      stages: [{ key: "s1" }],
      params: [{ name: "x" }],
      expectedOutputs: [{ label: "out" }],
    });
  });
});

describe("IDEMPOTENCY_TERMINAL_SESSION_STATUSES (subject-idempotency reuse gate)", () => {
  // Every focus_sessions.status enum value (schema/focus-sessions.ts), split into
  // the states that mean a run is still IN FLIGHT (reuse → no re-dispatch) vs
  // TERMINALLY done (a fresh run is allowed again). The idempotency-by-subject
  // check reuses a session iff its status is NOT in the terminal set.
  const IN_FLIGHT = [
    "active",
    "paused",
    "stale",
    "forming",
    "scheduled",
  ] as const;
  const TERMINAL = ["closed", "failed", "cancelled"] as const;

  it("treats NO in-flight state as terminal, so a stuck/aged subject is REUSED (Stellar-runaway regression)", () => {
    // Regression: keying reuse on 'active' alone re-spawned a fresh run daily once
    // the focus-session reaper aged the session active→'stale'. 'stale' (and
    // paused/forming/scheduled) must NOT count as terminal — otherwise the next
    // daily cron re-dispatches a duplicate run for the same subject.
    for (const status of IN_FLIGHT) {
      expect(IDEMPOTENCY_TERMINAL_SESSION_STATUSES).not.toContain(status);
    }
  });

  it("lists EXACTLY the terminal states, so a properly-closed subject is eligible again (no permanent lockout)", () => {
    // Once the playbook-run reaper force-fails the run and closes the session
    // (→ closed|failed|cancelled) — or the run completes (session → closed) — a
    // NEW run is allowed. If this set ever narrowed, a subject could re-spawn
    // daily again; if it widened, a subject could be locked out forever.
    expect([...IDEMPOTENCY_TERMINAL_SESSION_STATUSES].sort()).toEqual(
      [...TERMINAL].sort()
    );
  });
});
