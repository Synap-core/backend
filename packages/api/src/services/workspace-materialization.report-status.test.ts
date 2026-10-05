/**
 * `materializeReportStatus` — the HONEST status written to a proposal's
 * `materializeStatus` (workspace/create + workspace/update executors) and the
 * MCP `synap_create_workspace` reply. The defect: an idempotent re-hit of the
 * create branch (`created.created === false`) was reported `"created"`.
 */
import { describe, it, expect } from "vitest";
import { materializeReportStatus } from "./workspace-materialization-service.js";

describe("materializeReportStatus", () => {
  it("a genuinely new workspace → created", () => {
    expect(
      materializeReportStatus({
        status: "created",
        workspaceId: "ws-1",
        dependencies: [],
        created: { workspaceId: "ws-1", created: true, outcome: "created" },
      })
    ).toBe("created");
  });

  it.each(["unchanged", "reconciled"] as const)(
    "an idempotent re-hit (%s) → reused, never created",
    (outcome) => {
      expect(
        materializeReportStatus({
          status: "created",
          workspaceId: "ws-1",
          dependencies: [],
          created: { workspaceId: "ws-1", created: false, outcome },
        })
      ).toBe("reused");
    }
  );

  it("a compose → composed", () => {
    expect(
      materializeReportStatus({
        status: "composed",
        workspaceId: "ws-base",
        composeTargetWorkspaceId: "ws-base",
        dependencies: [],
        reconcile: {} as never,
      })
    ).toBe("composed");
  });
});
