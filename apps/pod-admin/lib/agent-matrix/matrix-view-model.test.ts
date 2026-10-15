import { describe, expect, it } from "vitest";
import {
  cellOfAnswers,
  collapseCells,
  type AgentMatrix,
  type MatrixAgentRow,
  type MatrixColumn,
  type MatrixProbeAnswer,
  type MatrixTypeGroup,
} from "@synap-core/types/agent-matrix";
import {
  TYPE_GROUP_CAP,
  cellAriaLabel,
  columnGroups,
  combineWidenOutcomes,
  decidingRuleIds,
  defaultExpanded,
  gridKeyAction,
  hasNoProcesses,
  markView,
  matrixState,
  probeViews,
  toggleExpanded,
  visibleRows,
  widenPlan,
} from "./matrix-view-model";

const FLOORS: MatrixColumn = {
  id: "floors",
  kind: "floors",
  label: "Floors",
  workspaceId: null,
  workspaceName: null,
  playbookId: null,
  probes: [
    { key: "floor:entity.delete", action: "entity.delete", profileSlug: null },
  ],
};
const DEALS: MatrixColumn = {
  id: "process:pb",
  kind: "process",
  label: "Work a deal",
  workspaceId: "ws-sales",
  workspaceName: "Sales",
  playbookId: "pb",
  probes: [
    { key: "entity.create:deal", action: "entity.create", profileSlug: "deal" },
    { key: "entity.update:deal", action: "entity.update", profileSlug: "deal" },
  ],
};
const OTHER: MatrixColumn = {
  id: "other:ws-sales",
  kind: "other",
  label: "Other work",
  workspaceId: "ws-sales",
  workspaceName: "Sales",
  playbookId: null,
  probes: [
    { key: "entity.create", action: "entity.create", profileSlug: null },
  ],
};
const COLUMNS = [FLOORS, DEALS, OTHER];

const ans = (
  probeKey: string,
  verdict: MatrixProbeAnswer["verdict"],
  rung = "default",
  ruleId: string | null = null
): MatrixProbeAnswer => ({ probeKey, verdict, rung, reason: "why", ruleId });

function agent(
  id: string,
  verdicts: {
    floors?: MatrixProbeAnswer[];
    deals?: MatrixProbeAnswer[];
    other?: MatrixProbeAnswer[];
  },
  o: Partial<MatrixAgentRow> = {}
): MatrixAgentRow {
  return {
    agentUserId: id,
    name: id,
    agentType: "claude-code",
    hostUserId: null,
    paused: false,
    ownedByViewer: true,
    cells: {
      floors: cellOfAnswers(
        verdicts.floors ?? [
          ans("floor:entity.delete", "ask", "destructive-actions-hard-floor"),
        ]
      ),
      "process:pb": cellOfAnswers(
        verdicts.deals ?? [
          ans("entity.create:deal", "auto"),
          ans("entity.update:deal", "auto"),
        ]
      ),
      "other:ws-sales": cellOfAnswers(
        verdicts.other ?? [ans("entity.create", "ask")]
      ),
    },
    ...o,
  };
}

function group(
  agentType: string,
  computers: Array<{
    host: string | null;
    label: string;
    agents: MatrixAgentRow[];
  }>
): MatrixTypeGroup {
  const collapse = (as: MatrixAgentRow[]) =>
    Object.fromEntries(
      COLUMNS.map((c) => [c.id, collapseCells(as.map((a) => a.cells[c.id]!))])
    );
  const all = computers.flatMap((c) => c.agents);
  return {
    agentType,
    cells: collapse(all),
    computers: computers.map((c) => ({
      hostUserId: c.host,
      label: c.label,
      cells: collapse(c.agents),
      agents: c.agents,
    })),
  };
}

const ALLOWED = agent("cc-1", {});
const ASKING = agent("cc-2", {
  deals: [ans("entity.create:deal", "ask"), ans("entity.update:deal", "auto")],
});
const LOOSE = agent(
  "codex-1",
  {},
  { agentType: "codex", ownedByViewer: false }
);

function matrix(groups: MatrixTypeGroup[], columns = COLUMNS): AgentMatrix {
  return { lens: "pod", columns, groups, partial: null };
}

const MATRIX = matrix([
  group("claude-code", [
    { host: "mac", label: "Mac", agents: [ALLOWED, ASKING] },
  ]),
  group("codex", [{ host: null, label: "No computer", agents: [LOOSE] }]),
]);

describe("marks", () => {
  it("draws each mark with its glyph, tone and vocabulary words", () => {
    expect(
      markView({ mark: "auto", split: { auto: 2, ask: 0, off: 0 } })
    ).toEqual({
      glyph: "✓",
      tone: "success",
      label: "Acts",
      splitWords: null,
    });
    expect(
      markView({ mark: "off", split: { auto: 0, ask: 0, off: 1 } }).glyph
    ).toBe("—");
  });

  it("a collapsed group shows ◐ + the split, never one member's verdict", () => {
    const claude = visibleRows(MATRIX, new Set(), false).rows[0]!;
    const deals = claude.cells["process:pb"]!;
    expect(deals.mark).toBe("mixed");
    const view = markView(deals);
    expect(view.glyph).toBe("◐");
    expect(view.splitWords).toBe("3 acts, 1 asks first");
  });

  it("a floors cell says it is locked to a screen reader", () => {
    const label = cellAriaLabel("cc-1", FLOORS, ALLOWED.cells["floors"]!);
    expect(label).toBe("cc-1, Floors: Asks first, locked platform limit");
    expect(cellAriaLabel("cc-1", DEALS, ALLOWED.cells["process:pb"]!)).toBe(
      "cc-1, Work a deal (Sales): Acts"
    );
  });
});

describe("columns under their space", () => {
  it("groups consecutive columns of one space under one header", () => {
    expect(
      columnGroups(COLUMNS).map((g) => [g.label, g.columns.length])
    ).toEqual([
      [null, 1],
      ["Sales", 2],
    ]);
  });
});

describe("rows: type → computer → agent", () => {
  it("collapsed: one row per type group", () => {
    const { rows } = visibleRows(MATRIX, new Set(), false);
    expect(rows.map((r) => r.key)).toEqual(["type:claude-code", "type:codex"]);
    expect(rows.map((r) => r.memberCount)).toEqual([2, 1]);
  });

  it("expanded: a real computer is a row; agents on no computer sit under their type", () => {
    const { rows } = visibleRows(MATRIX, defaultExpanded(MATRIX), false);
    expect(rows.map((r) => [r.kind, r.level, r.label])).toEqual([
      ["type", 1, "claude-code"],
      ["computer", 2, "Mac"],
      ["agent", 3, "cc-1"],
      ["agent", 3, "cc-2"],
      ["type", 1, "codex"],
      ["agent", 2, "codex-1"],
    ]);
  });

  it("toggling a group hides only that group's rows", () => {
    const open = toggleExpanded(
      defaultExpanded(MATRIX),
      "computer:claude-code:mac"
    );
    const { rows } = visibleRows(MATRIX, open, false);
    expect(rows.map((r) => r.label)).toEqual([
      "claude-code",
      "Mac",
      "codex",
      "codex-1",
    ]);
  });

  it("a big pod opens collapsed", () => {
    const many = Array.from({ length: 21 }, (_, i) => agent(`a${i}`, {}));
    const big = matrix([
      group("claude-code", [
        { host: null, label: "No computer", agents: many },
      ]),
    ]);
    expect(defaultExpanded(big).size).toBe(0);
  });

  it(`caps at ${TYPE_GROUP_CAP} type groups, then Show all`, () => {
    const groups = Array.from({ length: TYPE_GROUP_CAP + 3 }, (_, i) =>
      group(`type-${i}`, [
        { host: null, label: "No computer", agents: [agent(`x${i}`, {})] },
      ])
    );
    const capped = visibleRows(matrix(groups), new Set(), false);
    expect(capped.rows).toHaveLength(TYPE_GROUP_CAP);
    expect(capped.hiddenTypeGroups).toBe(3);
    const all = visibleRows(matrix(groups), new Set(), true);
    expect(all.rows).toHaveLength(TYPE_GROUP_CAP + 3);
    expect(all.hiddenTypeGroups).toBe(0);
  });
});

describe("keyboard model", () => {
  const size = { rows: 5, cols: 4 };
  it("arrows move and clamp at the edges", () => {
    expect(
      gridKeyAction("ArrowRight", { row: 0, col: 3 }, size, false)
    ).toEqual({
      type: "move",
      to: { row: 0, col: 3 },
    });
    expect(gridKeyAction("ArrowDown", { row: 1, col: 1 }, size, false)).toEqual(
      {
        type: "move",
        to: { row: 2, col: 1 },
      }
    );
    expect(gridKeyAction("ArrowUp", { row: 0, col: 1 }, size, false)).toEqual({
      type: "move",
      to: { row: 0, col: 1 },
    });
  });

  it("Home / End go to the row's ends; with a modifier, the grid's corners", () => {
    expect(gridKeyAction("End", { row: 2, col: 1 }, size, false)).toEqual({
      type: "move",
      to: { row: 2, col: 3 },
    });
    expect(
      gridKeyAction("Home", { row: 2, col: 3 }, size, false, true)
    ).toEqual({ type: "move", to: { row: 0, col: 0 } });
  });

  it("Enter opens the why of a cell; Space expands a group and does nothing on an agent", () => {
    expect(gridKeyAction("Enter", { row: 1, col: 2 }, size, false)).toEqual({
      type: "why",
      at: { row: 1, col: 2 },
    });
    expect(gridKeyAction(" ", { row: 1, col: 2 }, size, true)).toEqual({
      type: "toggle",
      at: { row: 1, col: 2 },
    });
    expect(gridKeyAction(" ", { row: 1, col: 2 }, size, false)).toBeNull();
    expect(gridKeyAction("Enter", { row: 1, col: 0 }, size, true)).toEqual({
      type: "toggle",
      at: { row: 1, col: 0 },
    });
  });
});

describe("WHY: widen and revoke", () => {
  it("offers Widen only on probes a rule can reach — never on the floors", () => {
    const deals = probeViews(DEALS, ASKING.cells["process:pb"]!);
    expect(deals.map((p) => [p.title, p.widenable])).toEqual([
      ["Create Deal", true],
      ["Update Deal", false],
    ]);
    // An ask on a floor rung, and the floors column itself, are never widenable.
    expect(
      probeViews(FLOORS, ASKING.cells["floors"]!).every((p) => !p.widenable)
    ).toBe(true);
    // Even an answer a rule could reach is locked in the floors column.
    const floorsDoc: MatrixColumn = {
      ...FLOORS,
      probes: [
        {
          key: "floor:document.update",
          action: "document.update",
          profileSlug: null,
        },
      ],
    };
    const reachable = cellOfAnswers([
      ans("floor:document.update", "ask", "default"),
    ]);
    expect(probeViews(floorsDoc, reachable)[0]!.widenable).toBe(false);
    // …the same answer in a space's column is offered (the control).
    expect(
      probeViews({ ...floorsDoc, kind: "other" }, reachable)[0]!.widenable
    ).toBe(true);
    // Other work's entity write names no kind: widening it would cover every kind.
    expect(
      probeViews(OTHER, ASKING.cells["other:ws-sales"]!)[0]!.widenable
    ).toBe(false);
  });

  it("your own agent widens to a rule; another user's agent asks its owner (decision 8)", () => {
    const deals = probeViews(DEALS, ASKING.cells["process:pb"]!);
    expect(widenPlan({ ownedByViewer: true }, deals)).toEqual({
      route: "rule",
      label: "Widen",
      probes: [DEALS.probes[0]],
    });
    expect(widenPlan({ ownedByViewer: false }, deals)).toMatchObject({
      route: "owner",
      label: "Ask the owner to widen",
    });
    expect(
      widenPlan(
        { ownedByViewer: true },
        probeViews(DEALS, ALLOWED.cells["process:pb"]!)
      )
    ).toBeNull();
  });

  it("names each rule that decided, once", () => {
    const cell = cellOfAnswers([
      ans("entity.create:deal", "auto", "governance-rule", "r1"),
      ans("entity.update:deal", "auto", "governance-rule", "r1"),
    ]);
    expect(decidingRuleIds(probeViews(DEALS, cell))).toEqual(["r1"]);
  });

  it("several outcomes read as one mark: a failure first, then the strongest", () => {
    expect(combineWidenOutcomes(["already_covered", "created"])).toBe(
      "created"
    );
    expect(combineWidenOutcomes(["proposed", "failed"])).toBe("failed");
    expect(combineWidenOutcomes([])).toBeNull();
  });
});

describe("page state", () => {
  it("a failed read is failed, never an empty matrix", () => {
    expect(
      matrixState({ isLoading: false, isError: true, data: undefined })
    ).toBe("failed");
    expect(
      matrixState({ isLoading: true, isError: false, data: undefined })
    ).toBe("loading");
    expect(
      matrixState({ isLoading: false, isError: false, data: matrix([]) })
    ).toBe("no-agents");
    expect(
      matrixState({ isLoading: false, isError: false, data: MATRIX })
    ).toBe("ready");
  });

  it("knows when no space has a process yet", () => {
    expect(hasNoProcesses(MATRIX)).toBe(false);
    expect(hasNoProcesses(matrix(MATRIX.groups, [FLOORS, OTHER]))).toBe(true);
  });
});
