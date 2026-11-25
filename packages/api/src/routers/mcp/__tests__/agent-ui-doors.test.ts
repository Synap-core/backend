/**
 * The three agent doors of plan 2c (pod document a73b34f0 §5) are REACHABLE
 * from an agent key, and each forwards to its one governed path:
 *
 *   - `synap_update_view`    → Hub `views.updateView` (validates, then the gate)
 *   - `synap_create_view`    → offers `pipeline` (refused by `views.create`
 *                              when the kind declares no lifecycle)
 *   - `synap_set_start_page` → `setStartPageDoor` → `workspaces.setPrimarySurface`
 *
 * Reachability, not shape: each tool is listed by `tools.list()`, unlocked by
 * the `build` group the UI skills unlock, and its handler hands the agent's
 * arguments to the door (asserted on the door's received value). The doors'
 * own checks are pinned beside them (views.update-validates-first,
 * views.create-pipeline, workspaces.set-primary-surface).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ setStartPageDoor: vi.fn() }));

vi.mock("../../../services/workspace-ops-doors.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/workspace-ops-doors.js")
  >()),
  setStartPageDoor: h.setStartPageDoor,
}));

import { tools } from "../tools/index.js";
import { TOOL_GROUPS, groupsForLoadSkillRef } from "../tool-profiles.js";
import { buildHandlers } from "../handlers/build.js";
import { workspaceHandlers } from "../handlers/workspace.js";

const WS = "00000000-0000-4000-8000-0000000000c1";
const VIEW = "00000000-0000-4000-8000-0000000000c2";

function ctx(toolName: string, args: Record<string, unknown>, extra = {}) {
  return {
    toolName,
    args,
    userId: "user-1",
    agentUserId: "agent-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    ...extra,
  } as never;
}

function body(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]!.text!) as Record<string, unknown>;
}

beforeEach(() => {
  h.setStartPageDoor.mockReset();
  h.setStartPageDoor.mockResolvedValue({
    status: "proposed",
    proposalId: "p1",
  });
});

describe("the agent UI doors are listed and unlocked with the build tools", () => {
  it("tools.list() offers synap_update_view, synap_set_start_page and a pipeline synap_create_view", async () => {
    const listed = await tools.list();
    const byName = new Map(listed.map((t) => [t.name, t]));
    expect(byName.has("synap_update_view")).toBe(true);
    expect(byName.has("synap_set_start_page")).toBe(true);
    const typeEnum = (
      byName.get("synap_create_view")!.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >
    ).type!.enum!;
    expect(typeEnum).toContain("pipeline");
    // Non-vacuity: the person's catalogue is still offered beside it.
    expect(typeEnum).toEqual(expect.arrayContaining(["bento", "kanban"]));
  });

  it("both new tools sit in the build group that the synap-ui skill unlocks", () => {
    expect(TOOL_GROUPS.build).toEqual(
      expect.arrayContaining(["synap_update_view", "synap_set_start_page"])
    );
    expect(groupsForLoadSkillRef("system/synap-ui/skill")).toContain("build");
  });
});

describe("synap_update_view forwards to the Hub's governed updateView", () => {
  it("hands the view, the new config, the agent and the reason to the door", async () => {
    const updateView = vi.fn(async () => ({
      status: "proposed",
      proposalId: "p2",
    }));
    const config = { blocks: [] };
    const out = await buildHandlers.synap_update_view!(
      ctx(
        "synap_update_view",
        { viewId: VIEW, config, reasoning: "Rearrange the deals bento" },
        { caller: { views: { updateView } } }
      )
    );
    expect(body(out as never)).toMatchObject({ status: "proposed" });
    expect(updateView).toHaveBeenCalledWith({
      userId: "user-1",
      viewId: VIEW,
      config,
      agentUserId: "agent-1",
      reasoning: "Rearrange the deals bento",
    });
  });

  it("refuses a call that changes nothing, without reaching the door", async () => {
    const updateView = vi.fn();
    const out = await buildHandlers.synap_update_view!(
      ctx(
        "synap_update_view",
        { viewId: VIEW },
        { caller: { views: { updateView } } }
      )
    );
    expect(body(out as never).error).toMatch(/name and\/or config/);
    expect(updateView).not.toHaveBeenCalled();
  });
});

describe("synap_set_start_page builds the one start-page descriptor", () => {
  const run = (args: Record<string, unknown>) =>
    workspaceHandlers.synap_set_start_page!(
      ctx("synap_set_start_page", { workspaceId: WS, ...args })
    );

  it("a cell", async () => {
    await run({ cellKey: "generated:lead-desk", title: "Leads" });
    expect(h.setStartPageDoor.mock.calls[0]![1]).toEqual({
      workspaceId: WS,
      primarySurface: {
        kind: "cell",
        cellKey: "generated:lead-desk",
        title: "Leads",
      },
      reasoning: undefined,
    });
  });

  it("a pod-app website", async () => {
    await run({
      url: "https://leads.example.com",
      podAppClientId: "https://leads.example.com/client.json",
      reasoning: "Open the CRM site",
    });
    expect(h.setStartPageDoor.mock.calls[0]![1]).toEqual({
      workspaceId: WS,
      primarySurface: {
        kind: "url",
        url: "https://leads.example.com",
        podApp: { clientId: "https://leads.example.com/client.json" },
      },
      reasoning: "Open the CRM site",
    });
  });

  it("back to the space's home", async () => {
    await run({ clear: true });
    expect(h.setStartPageDoor.mock.calls[0]![1]).toMatchObject({
      primarySurface: null,
    });
  });

  it("refuses two start pages at once, without reaching the door", async () => {
    const out = await run({ cellKey: "generated:a", url: "https://a.example" });
    expect(body(out as never).error).toMatch(/exactly one start page/);
    expect(h.setStartPageDoor).not.toHaveBeenCalled();
  });
});
