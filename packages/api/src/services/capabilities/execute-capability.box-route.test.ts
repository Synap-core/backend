import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A BOX skill (`executionMode: "box"`) is QUEUED by the one post-gate runner,
 * never sent to the JS isolate — and a queued run is not "proof it ran".
 *
 * Driven through the real `runResolvedSkill` (both doors' runner: the direct
 * run and the approved `capability.run`), with the queue and the isolate
 * mocked so the assertion is WHICH tier ran and WHAT the queue was told:
 *   - box → `enqueueBoxRun`, attributed to the agent that asked and the
 *     proposal that approved it (provenance), the isolate untouched;
 *   - the same row with `executionMode: "sync"` → the isolate (the routing key
 *     is the execution mode, nothing else);
 *   - a queued result issues NO `proven_at` stamp (the finish does, once the
 *     script really exited 0);
 *   - a queue refusal is the one failure channel, `kind: "error"`.
 */

const updates: unknown[] = [];

vi.mock("../skills/execute-skill-via-is.js", () => ({
  executeSkillViaIS: vi.fn(async () => ({
    success: true,
    result: { ran: "is" },
  })),
}));
vi.mock("../box-runs/box-runs.js", async (importActual) => {
  const actual = await importActual<typeof import("../box-runs/box-runs.js")>();
  return {
    ...actual,
    enqueueBoxRun: vi.fn(async () => ({
      ok: true,
      run: { id: "b1" },
      result: { status: "queued", boxRunId: "b1", message: "Queued" },
    })),
  };
});
vi.mock("@synap/database", async (importActual) => {
  const actual = await importActual<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
    },
  };
});

import {
  runResolvedSkill,
  type ResolvedSkillRow,
} from "./execute-capability.js";
import { executeSkillViaIS } from "../skills/execute-skill-via-is.js";
import { enqueueBoxRun } from "../box-runs/box-runs.js";

function row(overrides: Partial<ResolvedSkillRow>): ResolvedSkillRow {
  return {
    id: "s1",
    name: "chart_csv",
    kind: "code",
    providerSpec: null,
    metadata: null,
    executionMode: "box",
    ...overrides,
  };
}

describe("runResolvedSkill — a box skill is queued, never run in the isolate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updates.length = 0;
  });

  it("queues it, attributed to who asked and the approving proposal", async () => {
    const out = await runResolvedSkill(
      row({}),
      { csv: "a,b" },
      {
        userId: "person",
        workspaceId: "ws1",
        sessionId: "sess1",
        provenance: { agentUserId: "agent1", proposalId: "p1" },
      }
    );
    expect(out).toEqual({
      kind: "run",
      skillId: "s1",
      result: { status: "queued", boxRunId: "b1", message: "Queued" },
    });
    expect(enqueueBoxRun).toHaveBeenCalledWith({
      skillId: "s1",
      parameters: { csv: "a,b" },
      userId: "person",
      agentUserId: "agent1",
      sessionId: "sess1",
      workspaceId: "ws1",
      proposalId: "p1",
    });
    expect(executeSkillViaIS).not.toHaveBeenCalled();
    // Queued is not performed: no proven_at stamp.
    expect(updates).toHaveLength(0);
  });

  it("the same row in sync mode runs in the isolate (the mode is the key)", async () => {
    const out = await runResolvedSkill(
      row({ executionMode: "sync" }),
      {},
      {
        userId: "person",
        workspaceId: null,
      }
    );
    expect(out).toMatchObject({ kind: "run", result: { ran: "is" } });
    expect(enqueueBoxRun).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
  });

  it("a queue refusal is kind:error", async () => {
    vi.mocked(enqueueBoxRun).mockResolvedValueOnce({
      ok: false,
      error:
        'Box skill "chart_csv" has no valid box declaration (box: invalid).',
    });
    const out = await runResolvedSkill(
      row({}),
      {},
      {
        userId: "person",
        workspaceId: null,
      }
    );
    expect(out).toMatchObject({ kind: "error" });
    expect(executeSkillViaIS).not.toHaveBeenCalled();
  });
});
