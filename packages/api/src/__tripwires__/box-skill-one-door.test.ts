import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * TRIPWIRE — a BOX skill is decided by the one skill door (`runSkill`), never
 * by one of its callers.
 *
 * A box skill's code is a Python or Node script for the person's own
 * computer. When only `executeCapability` knew about box, the person's Run
 * and both dry-runs (which call `runSkill` directly) sent the script to the
 * pod isolate, where a plain-JS node script ran with the pod's bridges instead
 * of in a box with its declared hosts. So the routing lives in the door, and
 * this drives the door itself:
 *   - run → `enqueueBoxRun`, attributed to the agent that asked and the
 *     proposal that approved it; no runtime is called;
 *   - dry-run → "no preview", nothing queued, no runtime called;
 *   - under the `SKILL_RUNTIME=is` rollback too (the box decision is before
 *     the runtime pick);
 *   - the same skill in `sync` mode reaches the runtime (the mode is the key);
 *   - through the post-gate runner (`runResolvedSkill`), the queued handle is
 *     the result, with no `proven_at` stamp (queued is not performed), and a
 *     queue refusal is the one failure channel, `kind: "error"`.
 */

const h = vi.hoisted(() => ({ mode: "box", updates: [] as unknown[] }));

vi.mock("../services/skills/run-skill-in-sandbox.js", () => ({
  runSkillInSandbox: vi.fn(async () => ({
    success: true,
    result: { ran: "pod" },
  })),
}));
vi.mock("../services/skills/execute-skill-via-is.js", () => ({
  executeSkillViaIS: vi.fn(async () => ({ success: true, result: {} })),
  dryRunSkillViaIS: vi.fn(async () => ({ success: true, result: {} })),
}));
vi.mock("../services/box-runs/box-runs.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/box-runs/box-runs.js")>()),
  enqueueBoxRun: vi.fn(async () => ({
    ok: true,
    run: { id: "b1" },
    result: { status: "queued", boxRunId: "b1", message: "Queued" },
  })),
}));
vi.mock("@synap/database", async (importActual) => {
  const actual = await importActual<typeof import("@synap/database")>();
  const { skills } = await import("@synap/database/schema");
  return {
    ...actual,
    db: {
      // The door's skill read (`.limit`) and the runner's links read (awaited).
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows = table === skills ? [{ executionMode: h.mode }] : [];
            return Object.assign(Promise.resolve(rows), {
              limit: async () => rows,
            });
          },
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: async () => {
            h.updates.push(values);
          },
        }),
      }),
    },
  };
});

import { runSkill, BOX_NO_PREVIEW } from "../services/skills/run-skill.js";
import { runResolvedSkill } from "../services/capabilities/execute-capability.js";
import { runSkillInSandbox } from "../services/skills/run-skill-in-sandbox.js";
import {
  executeSkillViaIS,
  dryRunSkillViaIS,
} from "../services/skills/execute-skill-via-is.js";
import { enqueueBoxRun } from "../services/box-runs/box-runs.js";

const RUNTIMES = [runSkillInSandbox, executeSkillViaIS, dryRunSkillViaIS];

describe("tripwire: the one skill door handles a box skill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mode = "box";
    h.updates.length = 0;
  });
  afterEach(() => {
    delete process.env.SKILL_RUNTIME;
  });

  it("a run is queued with who asked; no runtime runs the script", async () => {
    const out = await runSkill({
      skillId: "s1",
      userId: "person",
      parameters: { csv: "a,b" },
      workspaceId: "ws1",
      sessionId: "sess1",
      provenance: { agentUserId: "agent1", proposalId: "p1" },
    });
    expect(out).toMatchObject({
      success: true,
      result: { status: "queued", boxRunId: "b1" },
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
    for (const rt of RUNTIMES) expect(rt).not.toHaveBeenCalled();
  });

  it("a dry-run answers 'no preview': nothing queued, nothing run", async () => {
    const out = await runSkill({
      skillId: "s1",
      userId: "person",
      parameters: {},
      dryRun: true,
    });
    expect(out).toMatchObject({ success: false, error: BOX_NO_PREVIEW });
    expect(enqueueBoxRun).not.toHaveBeenCalled();
    for (const rt of RUNTIMES) expect(rt).not.toHaveBeenCalled();
  });

  it("under SKILL_RUNTIME=is too, run and dry-run", async () => {
    process.env.SKILL_RUNTIME = "is";
    await runSkill({ skillId: "s1", userId: "person" });
    await runSkill({ skillId: "s1", userId: "person", dryRun: true });
    expect(enqueueBoxRun).toHaveBeenCalledTimes(1);
    for (const rt of RUNTIMES) expect(rt).not.toHaveBeenCalled();
  });

  it("the same skill in sync mode reaches the runtime (the mode is the key)", async () => {
    h.mode = "sync";
    const out = await runSkill({ skillId: "s1", userId: "person" });
    expect(out).toMatchObject({ success: true, result: { ran: "pod" } });
    expect(enqueueBoxRun).not.toHaveBeenCalled();
    expect(runSkillInSandbox).toHaveBeenCalledTimes(1);
  });

  it("through the post-gate runner: queued handle, no proven_at, attribution kept", async () => {
    const row = {
      id: "s1",
      name: "chart_csv",
      kind: "code",
      providerSpec: null,
      metadata: null,
      parameters: null,
      executionMode: "box",
    };
    const out = await runResolvedSkill(
      row,
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
    expect(enqueueBoxRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentUserId: "agent1", proposalId: "p1" })
    );
    expect(h.updates).toHaveLength(0);
    for (const rt of RUNTIMES) expect(rt).not.toHaveBeenCalled();

    vi.mocked(enqueueBoxRun).mockResolvedValueOnce({
      ok: false,
      error: "Skill is not approved for execution.",
    });
    const refused = await runResolvedSkill(
      row,
      {},
      {
        userId: "person",
        workspaceId: null,
      }
    );
    expect(refused).toMatchObject({
      kind: "error",
      message: "Skill is not approved for execution.",
    });
  });
});
