/**
 * The approval rows of one tool (lane W3): which rows name it and at which
 * level, every AI's mode on the tool and on each action (a row on the action
 * outranks the tool's; a tie goes to the stricter verdict, as at the gate),
 * the rows to write and take back for a change, an agent's own rows, and the
 * agents × tools grid.
 */
import { describe, expect, it } from "vitest";
import {
  actionEveryoneState,
  agentOwnRows,
  decidingRow,
  gridCellKey,
  planEveryoneChange,
  toolApprovals,
  toolEveryoneState,
  toolIndex,
  toolRowLevel,
  toolShapeOf,
  toolsGrid,
  verbDisplayName,
  type ToolRuleRow,
  type ToolShape,
} from "./tool-approvals-model";

const TOOL = "cap-apify";
const MEMBER = "tool-row-apify";
const AGENT = "agent-1";

const SHAPE: ToolShape = {
  id: TOOL,
  memberToolIds: [MEMBER],
  actions: [
    { verbId: "apify_run_actor", skillId: "skill-run" },
    { verbId: "apify_linkedin_profile", skillId: null },
  ],
};

let seq = 0;
function row(over: Partial<ToolRuleRow & { createdBy: string }> = {}) {
  return {
    id: `r${++seq}`,
    principalKind: "any",
    agentUserId: null,
    agentLabel: null,
    principalClass: null,
    scopeKind: "pod",
    workspaceId: null,
    targetKind: "capability",
    targetPattern: TOOL,
    verdict: "auto",
    createdBy: "user:u1",
    ...over,
  } as ToolRuleRow & { createdBy: string };
}

describe("verbDisplayName — an action in words, never its id (finding 47ff4216)", () => {
  it("a label that is the id → the vocabulary's words", () => {
    const name = verbDisplayName({
      verbId: "apify_run_actor",
      label: "apify_run_actor",
    });
    expect(name).not.toBe("apify_run_actor");
    expect(name).not.toContain("_");
  });

  it("a declared name is kept", () => {
    expect(
      verbDisplayName({
        verbId: "apify_linkedin_profile",
        label: "Read a LinkedIn profile",
      })
    ).toBe("Read a LinkedIn profile");
  });

  it("an id-shaped label other than the id is still not shown raw", () => {
    expect(
      verbDisplayName({ verbId: "gmail_send", label: "gmail.send" })
    ).not.toContain(".");
  });
});

describe("toolRowLevel — which rows name the tool", () => {
  it("the container and a member tool row name the whole tool", () => {
    expect(toolRowLevel(row({ targetPattern: TOOL }), SHAPE)).toEqual({
      level: "tool",
    });
    expect(toolRowLevel(row({ targetPattern: MEMBER }), SHAPE)).toEqual({
      level: "tool",
    });
  });

  it("an action is named by its verb id or by its skill row id", () => {
    expect(
      toolRowLevel(row({ targetPattern: "apify_run_actor" }), SHAPE)
    ).toEqual({ level: "action", verbId: "apify_run_actor" });
    expect(toolRowLevel(row({ targetPattern: "skill-run" }), SHAPE)).toEqual({
      level: "action",
      verbId: "apify_run_actor",
    });
  });

  it("another tool's row, or a row that is no tool rule, is not this tool's", () => {
    expect(
      toolRowLevel(row({ targetPattern: "gmail_send" }), SHAPE)
    ).toBeNull();
    expect(
      toolRowLevel(
        row({ targetKind: "action", targetPattern: "apify_run_actor" }),
        SHAPE
      )
    ).toBeNull();
  });
});

describe("toolShapeOf", () => {
  it("takes its member tool rows from the composition, not its skills", () => {
    const shape = toolShapeOf(
      { id: TOOL, verbs: [{ verbId: "a", skillId: "s" }] },
      [
        { kind: "tool", id: MEMBER },
        { kind: "skill", id: "s" },
      ]
    );
    expect(shape?.memberToolIds).toEqual([MEMBER]);
    expect(toolShapeOf({ id: null, verbs: [] }, [])).toBeNull();
  });
});

describe("every AI's mode", () => {
  it("no row: asks first, by default", () => {
    const a = toolApprovals([], SHAPE);
    expect(toolEveryoneState(a)).toEqual({
      value: "ask",
      mode: "ask",
      from: "default",
    });
    expect(actionEveryoneState(a, "apify_run_actor").from).toBe("default");
  });

  it("everyone × the whole tool → each action follows it (never shown as 'asks first')", () => {
    const a = toolApprovals([row({ verdict: "auto" })], SHAPE);
    expect(toolEveryoneState(a).mode).toBe("auto");
    expect(actionEveryoneState(a, "apify_run_actor")).toEqual({
      value: "tool",
      mode: "auto",
      from: "tool",
    });
  });

  it("a row on the action outranks the tool's row", () => {
    const a = toolApprovals(
      [
        row({ verdict: "auto" }),
        row({ targetPattern: "apify_run_actor", verdict: "deny" }),
      ],
      SHAPE
    );
    expect(actionEveryoneState(a, "apify_run_actor")).toEqual({
      value: "never",
      mode: "never",
      from: "action",
    });
    expect(actionEveryoneState(a, "apify_linkedin_profile").mode).toBe("auto");
  });

  it("an explicit asks-first row on the action reads 'asks first', not the tool's", () => {
    const a = toolApprovals(
      [
        row({ verdict: "auto" }),
        row({ targetPattern: "apify_run_actor", verdict: "propose" }),
      ],
      SHAPE
    );
    expect(actionEveryoneState(a, "apify_run_actor")).toEqual({
      value: "ask",
      mode: "ask",
      from: "action",
    });
  });

  it("a tie goes to the stricter verdict, as at the gate (never > asks first > runs)", () => {
    expect(
      decidingRow([row({ verdict: "auto" }), row({ verdict: "propose" })])
        ?.verdict
    ).toBe("propose");
    expect(
      decidingRow([
        row({ verdict: "propose" }),
        row({ verdict: "deny" }),
        row({ verdict: "auto" }),
      ])?.verdict
    ).toBe("deny");
  });

  it("an agent, a class or a space row is an exception, never every AI's mode", () => {
    const a = toolApprovals(
      [
        row({ principalKind: "agent", agentUserId: AGENT, verdict: "auto" }),
        row({ principalKind: "class", principalClass: "machine" }),
        row({ scopeKind: "workspace", workspaceId: "ws-1" }),
        row({
          principalKind: "agent",
          agentUserId: AGENT,
          targetPattern: "apify_run_actor",
        }),
      ],
      SHAPE
    );
    expect(toolEveryoneState(a).from).toBe("default");
    expect(a.tool.exceptions).toHaveLength(3);
    expect(a.actions.apify_run_actor?.exceptions).toHaveLength(1);
    expect(a.count).toBe(4);
  });
});

describe("planEveryoneChange — rows to write, then take back", () => {
  const current = (verdict: ToolRuleRow["verdict"], pattern = TOOL) =>
    [{ id: "old", verdict, targetPattern: pattern }] as const;

  it("the whole tool to 'runs on its own': one row naming the container, the old one taken back after", () => {
    expect(
      planEveryoneChange({
        pattern: TOOL,
        level: "tool",
        current: current("deny"),
        toolMode: null,
        next: "auto",
      })
    ).toEqual({
      create: {
        principalKind: "any",
        scopeKind: "pod",
        targetKind: "capability",
        targetPattern: TOOL,
        verdict: "auto",
      },
      revoke: ["old"],
    });
  });

  it("the whole tool to 'asks first': no row, the gate's default", () => {
    expect(
      planEveryoneChange({
        pattern: TOOL,
        level: "tool",
        current: current("auto"),
        toolMode: null,
        next: "ask",
      })
    ).toEqual({ create: null, revoke: ["old"] });
  });

  it("an action to 'asks first' under a tool that runs on its own: an explicit asks-first row", () => {
    expect(
      planEveryoneChange({
        pattern: "apify_run_actor",
        level: "action",
        current: [],
        toolMode: "auto",
        next: "ask",
      })?.create?.verdict
    ).toBe("propose");
  });

  it("an action to 'asks first' with no tool row: no row", () => {
    expect(
      planEveryoneChange({
        pattern: "apify_run_actor",
        level: "action",
        current: current("auto", "apify_run_actor"),
        toolMode: null,
        next: "ask",
      })
    ).toEqual({ create: null, revoke: ["old"] });
  });

  it("'as the tool': every row on the action is taken back", () => {
    expect(
      planEveryoneChange({
        pattern: "apify_run_actor",
        level: "action",
        current: current("propose", "apify_run_actor"),
        toolMode: "auto",
        next: "tool",
      })
    ).toEqual({ create: null, revoke: ["old"] });
  });

  it("already so: nothing to do", () => {
    expect(
      planEveryoneChange({
        pattern: TOOL,
        level: "tool",
        current: current("auto"),
        toolMode: null,
        next: "auto",
      })
    ).toBeNull();
    expect(
      planEveryoneChange({
        pattern: TOOL,
        level: "tool",
        current: [],
        toolMode: null,
        next: "ask",
      })
    ).toBeNull();
  });

  it("a member tool row with the same verdict is replaced by the container's", () => {
    const change = planEveryoneChange({
      pattern: TOOL,
      level: "tool",
      current: current("auto", MEMBER),
      toolMode: null,
      next: "auto",
    });
    expect(change?.create?.targetPattern).toBe(TOOL);
    expect(change?.revoke).toEqual(["old"]);
  });
});

describe("toolIndex — which tool a pattern belongs to", () => {
  const index = toolIndex(
    [
      {
        id: TOOL,
        name: "Apify",
        verbs: [{ verbId: "apify_run_actor", skillId: "skill-run" }],
      },
    ],
    [{ id: TOOL, members: [{ kind: "tool", id: MEMBER }] }]
  );
  it("the container, each action (verb id or skill id) and each member tool row", () => {
    expect(index.get(TOOL)).toEqual({ id: TOOL, name: "Apify", verbId: null });
    expect(index.get("apify_run_actor")?.verbId).toBe("apify_run_actor");
    expect(index.get("skill-run")?.id).toBe(TOOL);
    expect(index.get(MEMBER)).toEqual({
      id: TOOL,
      name: "Apify",
      verbId: null,
    });
    expect(index.get("unknown")).toBeUndefined();
  });
});

describe("agentOwnRows — what an agent's page lists", () => {
  it("its own rows only, without its posture's rows and its computer's copies", () => {
    const own = row({ principalKind: "agent", agentUserId: AGENT });
    const rows = [
      own,
      row({ principalKind: "agent", agentUserId: "other" }),
      row({}),
      row({
        principalKind: "agent",
        agentUserId: AGENT,
        createdBy: "system:settings-mirror:u1",
      }),
      row({
        principalKind: "agent",
        agentUserId: AGENT,
        createdBy: "system:host-seed:r1",
      }),
    ];
    expect(agentOwnRows(rows, AGENT)).toEqual([own]);
  });
});

describe("toolsGrid — agents × tools, from the rows", () => {
  const index = toolIndex(
    [
      {
        id: TOOL,
        name: "Apify",
        verbs: [
          { verbId: "apify_run_actor", skillId: null },
          { verbId: "apify_linkedin_profile", skillId: null },
        ],
      },
    ],
    []
  );

  it("one column per tool (its actions folded in), every AI first, one mark per cell", () => {
    const grid = toolsGrid(
      [
        row({ principalKind: "agent", agentUserId: AGENT, verdict: "deny" }),
        row({ verdict: "auto" }),
        row({ targetPattern: "apify_run_actor", verdict: "auto" }),
      ],
      index
    );
    expect(grid.principals.map((p) => p.key)).toEqual(["any", AGENT]);
    expect(grid.tools.map((t) => t.key)).toEqual([TOOL]);
    expect(grid.cells.get(gridCellKey("any", TOOL))).toEqual({
      mark: "auto",
      count: 2,
    });
    expect(grid.cells.get(gridCellKey(AGENT, TOOL))?.mark).toBe("never");
  });

  it("rows that differ in one cell are 'mixed'; an agent with no row there has no cell", () => {
    const grid = toolsGrid(
      [
        row({ targetPattern: "apify_run_actor", verdict: "auto" }),
        row({ targetPattern: "apify_linkedin_profile", verdict: "deny" }),
        row({
          principalKind: "agent",
          agentUserId: AGENT,
          targetPattern: "gmail_send",
        }),
      ],
      index
    );
    expect(grid.cells.get(gridCellKey("any", TOOL))?.mark).toBe("mixed");
    expect(grid.cells.get(gridCellKey(AGENT, TOOL))).toBeUndefined();
    // A pattern no tool holds is its own column, with no door.
    expect(grid.tools.find((t) => t.key === "gmail_send")?.toolId).toBeNull();
  });

  it("a row that names no tool is not in the grid", () => {
    const grid = toolsGrid(
      [row({ targetKind: "action", targetPattern: "entity.create" })],
      index
    );
    expect(grid.principals).toEqual([]);
    expect(grid.tools).toEqual([]);
  });
});
