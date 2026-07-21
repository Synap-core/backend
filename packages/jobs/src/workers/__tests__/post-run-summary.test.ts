import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type {
  Automation,
  AutomationRun,
  AutomationStepRun,
  Channel,
} from "@synap/database/schema";
import { ChannelRepository } from "@synap/database";
import {
  SUMMARY_MESSAGE_UNCLAIMED,
  resolveNarrationMode,
  renderSummary,
  DEFAULT_NARRATION_MODE,
  resolveResultRouting,
  DEFAULT_RESULT_ROUTING,
  resolveRunChannel,
} from "../../utils/post-run-summary.js";

// The exactly-once claim guards on `summary_message_id IS NULL`. The claim
// UPDATE ANDs this with `id = runId`; if a future edit keyed the guard on the
// wrong column (or dropped the IS NULL), the finalizer and the reaper could both
// narrate the same run. Lock the SHAPE, mirroring the reaper's fragment test.
describe("SUMMARY_MESSAGE_UNCLAIMED claim predicate", () => {
  const rendered = new PgDialect().sqlToQuery(SUMMARY_MESSAGE_UNCLAIMED).sql;

  it("guards the claim on the summary_message_id column being NULL", () => {
    expect(rendered).toContain("summary_message_id");
    expect(rendered.toLowerCase()).toContain("is null");
  });
});

describe("resolveNarrationMode", () => {
  it("defaults to 'always' when unset or unknown", () => {
    expect(resolveNarrationMode(null)).toBe(DEFAULT_NARRATION_MODE);
    expect(resolveNarrationMode({} as Automation["metadata"])).toBe("always");
    expect(
      resolveNarrationMode({ narrationMode: "bogus" } as Automation["metadata"])
    ).toBe("always");
  });

  it("reads a valid mode from metadata", () => {
    for (const m of ["always", "changes", "failures", "off"] as const) {
      expect(
        resolveNarrationMode({ narrationMode: m } as Automation["metadata"])
      ).toBe(m);
    }
  });
});

describe("resolveResultRouting", () => {
  it("defaults to per_type when unset or unknown", () => {
    expect(resolveResultRouting(null)).toBe(DEFAULT_RESULT_ROUTING);
    expect(resolveResultRouting({} as Automation["metadata"])).toBe("per_type");
    expect(
      resolveResultRouting({
        resultRouting: "bogus",
      } as Automation["metadata"])
    ).toBe("per_type");
  });

  it("reads per_entity / trigger from metadata", () => {
    expect(
      resolveResultRouting({
        resultRouting: "per_entity",
      } as Automation["metadata"])
    ).toBe("per_entity");
    expect(
      resolveResultRouting({
        resultRouting: "trigger",
      } as Automation["metadata"])
    ).toBe("trigger");
  });
});

// resolveRunChannel is the ONE door both the narration path and the executor's
// session-open use. Spy on the repo resolvers (the constructor touches no DB) to
// assert which room a run's activity lands in per routing mode — without a live
// channel row.
describe("resolveRunChannel routing", () => {
  const entitySpy = vi.spyOn(
    ChannelRepository.prototype,
    "ensureEntityChannel"
  );
  const typeSpy = vi.spyOn(
    ChannelRepository.prototype,
    "ensureAutomationRunChannel"
  );

  beforeEach(() => {
    vi.clearAllMocks();
    entitySpy.mockResolvedValue({ id: "entity-ch" } as Channel);
    typeSpy.mockResolvedValue({ id: "type-ch" } as Channel);
  });

  const automationFor = (over: Partial<Automation>): Automation =>
    ({
      id: "auto-1",
      name: "Nightly Sync",
      createdBy: "owner-1",
      triggerConfig: null,
      metadata: {},
      ...over,
    }) as Automation;

  it("per_entity + a run subject → the subject's own channel", async () => {
    const id = await resolveRunChannel(
      automationFor({ metadata: { resultRouting: "per_entity" } }),
      run({ subjectEntityId: "ent-9", workspaceId: "ws-1" })
    );
    expect(id).toBe("entity-ch");
    expect(entitySpy).toHaveBeenCalledWith("ent-9", "owner-1", "ws-1", {
      title: "Nightly Sync",
    });
    expect(typeSpy).not.toHaveBeenCalled();
  });

  it("per_entity but no run subject → falls back to the per-type run channel", async () => {
    const id = await resolveRunChannel(
      automationFor({ metadata: { resultRouting: "per_entity" } }),
      run({ subjectEntityId: null })
    );
    expect(id).toBe("type-ch");
    expect(entitySpy).not.toHaveBeenCalled();
    expect(typeSpy).toHaveBeenCalledOnce();
  });

  it("default (no resultRouting) → per-type run channel, unchanged", async () => {
    const id = await resolveRunChannel(
      automationFor({}),
      run({ subjectEntityId: "ent-9" })
    );
    expect(id).toBe("type-ch");
    expect(entitySpy).not.toHaveBeenCalled();
    expect(typeSpy).toHaveBeenCalledOnce();
  });

  it("default + a trigger-bound channel → the trigger channel wins", async () => {
    const id = await resolveRunChannel(
      automationFor({ triggerConfig: { channelId: "trig-ch" } as never }),
      run({ subjectEntityId: "ent-9" })
    );
    expect(id).toBe("trig-ch");
    expect(entitySpy).not.toHaveBeenCalled();
    expect(typeSpy).not.toHaveBeenCalled();
  });
});

// Minimal fixtures — only the fields the renderer reads, cast to the row types.
const automation = { id: "auto-1", name: "Nightly Sync" } as Automation;

function run(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: "run-1",
    automationId: "auto-1",
    status: "completed",
    stepsCompleted: 3,
    stepsFailed: 0,
    startedAt: new Date("2026-07-18T10:00:00.000Z"),
    completedAt: new Date("2026-07-18T10:00:02.100Z"),
    errorMessage: null,
    ...overrides,
  } as AutomationRun;
}

function step(overrides: Partial<AutomationStepRun>): AutomationStepRun {
  return {
    status: "completed",
    nodeId: "node-a",
    output: {},
    errorMessage: null,
    startedAt: new Date("2026-07-18T10:00:00.500Z"),
    ...overrides,
  } as AutomationStepRun;
}

describe("renderSummary", () => {
  it("success: automation chip, step count, duration, and created entity chips", () => {
    const content = renderSummary({
      automation,
      run: run({}),
      steps: [
        step({ output: { status: "created", entityId: "e1", title: "Acme" } }),
        step({ output: { status: "updated", entityId: "e2" } }),
      ],
      status: "success",
    });
    expect(content).toBe(
      "✅ [[automation:auto-1|Nightly Sync]] ran — 3 steps, 2.1s\n" +
        "Created [[entity:e1|Acme]]"
    );
  });

  it("success: no created line when no step created an entity", () => {
    const content = renderSummary({
      automation,
      run: run({ stepsCompleted: 1 }),
      steps: [step({ output: { status: "sent" } })],
      status: "success",
    });
    expect(content).toBe(
      "✅ [[automation:auto-1|Nightly Sync]] ran — 1 step, 2.1s"
    );
  });

  it("failure: failing step name, n-of-m, and the first error line", () => {
    const content = renderSummary({
      automation,
      run: run({
        status: "failed",
        stepsCompleted: 1,
        stepsFailed: 1,
        errorMessage: null,
      }),
      steps: [
        step({ status: "completed", nodeId: "fetch" }),
        step({
          status: "failed",
          nodeId: "enrich",
          errorMessage: "Upstream 500\nstack trace line",
        }),
      ],
      status: "failure",
    });
    expect(content).toBe(
      '⚠️ [[automation:auto-1|Nightly Sync]] failed at step "enrich" — 1 of 2 steps\n' +
        "Upstream 500"
    );
  });

  it("timeout: static calm copy, no step detail", () => {
    const content = renderSummary({
      automation,
      run: run({ status: "failed", stepsCompleted: 0, stepsFailed: 0 }),
      steps: [],
      status: "timeout",
    });
    expect(content).toBe(
      "⏱️ [[automation:auto-1|Nightly Sync]] timed out — worker died or hung, no steps recorded"
    );
  });
});
