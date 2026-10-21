/**
 * The automation status door's input normaliser (fb1020): an automation that
 * moves a task to `in_progress` against a lifecycle declaring `in-progress`
 * lands on the DECLARED key — the classification, the governance data and the
 * compare-and-set write all carry it, exactly as the api `moveStatus` door.
 *
 * Only the database boundary is replaced (target resolution, the CAS write,
 * the event dispatch, and the governance gate's reads). The normaliser and
 * the classifier are the REAL `@synap/database` functions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  apply: vi.fn(),
  gate: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  resolveStatusMoveTarget: vi.fn(async () => ({
    ok: true,
    target: {
      entityId: "e1",
      entityType: "task",
      workspaceId: "w1",
      facetId: null,
      role: null,
      current: "todo",
      lifecycle: {
        propertySlug: "status",
        propertyDefId: "d1",
        declaredOnProfileId: "p1",
        unclassified: [],
        options: [
          { key: "todo", category: "open" },
          { key: "in-progress", category: "active" },
          { key: "done", category: "done" },
        ],
      },
    },
  })),
  applyStatusMove: h.apply,
}));
vi.mock("@synap/events", () => ({ dispatchLifecycleTransition: h.emit }));
vi.mock("../automation-governance.js", () => ({
  checkAutomationWriteOrPropose: h.gate,
}));

import { moveStatusFromAutomation } from "../lifecycle-move.js";

const MOVE = { ownerId: "u1", workspaceId: "w1", entityId: "e1" };

beforeEach(() => {
  h.apply.mockReset();
  h.gate.mockReset();
  h.emit.mockReset();
});

describe("moveStatusFromAutomation input normaliser", () => {
  it("moves a separator variant to the declared option, governed and written as it", async () => {
    h.gate.mockResolvedValue({ granted: true });
    h.apply.mockResolvedValue({
      status: "moved",
      transition: { transitionId: "t1", to: "in-progress" },
    });

    const r = await moveStatusFromAutomation({ ...MOVE, to: "in_progress" });

    expect(r.status).toBe("moved");
    expect(h.gate.mock.calls[0][0]).toMatchObject({
      lifecycleMove: { intoTerminal: false, humanOnly: false },
      data: { expectedFrom: "todo", to: "in-progress" },
    });
    expect(h.apply.mock.calls[0][1]).toMatchObject({ to: "in-progress" });
    expect(h.emit).toHaveBeenCalledWith("t1");
  });

  it("still refuses a value that is no declared option, without governing", async () => {
    const r = await moveStatusFromAutomation({ ...MOVE, to: "doing" });
    expect(r).toMatchObject({ status: "refused", code: "UNKNOWN_OPTION" });
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });
});
