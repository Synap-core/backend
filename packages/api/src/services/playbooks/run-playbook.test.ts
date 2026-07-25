import { describe, it, expect } from "vitest";
import {
  deriveForceProposeWrites,
  buildRunSessionMetadata,
  buildDefinitionSnapshot,
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
      automationChainContext: {
        automationRunId: "run-1",
        automationId: "auto-1",
        chainDepth: 2,
        rootRunId: "root-1",
        chainAutomationIds: ["auto-1"],
      },
    });
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
