import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, userVisibleWhere } = vi.hoisted(() => ({
  execute: vi.fn(),
  userVisibleWhere: vi.fn(() => ({ userFloor: true })),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { execute },
  };
});

vi.mock("../../utils/user-visible-where.js", () => ({
  userVisibleWhere,
}));

import { listRecentRunsByFlows } from "./recent-by-flows.js";

const AUTO_ID = "00000000-0000-4000-8000-000000000001";
const PLAYBOOK_ID = "00000000-0000-4000-8000-000000000002";

function sqlText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node !== "object" || node === null) return "";
  const name = "name" in node && typeof node.name === "string" ? node.name : "";
  const value = "value" in node ? node.value : undefined;
  const chunks = "queryChunks" in node ? node.queryChunks : undefined;
  return [
    name,
    ...(Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []),
    ...(Array.isArray(chunks) ? chunks.map(sqlText) : []),
  ].join("");
}

describe("listRecentRunsByFlows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses one query per ledger and preserves empty requested histories", async () => {
    execute
      .mockResolvedValueOnce([
        {
          id: "run-a",
          flowId: AUTO_ID,
          status: "completed",
          startedAt: "2026-07-31T00:00:00.000Z",
          completedAt: "2026-07-31T00:00:01.000Z",
        },
      ])
      .mockResolvedValueOnce([]);

    const histories = await listRecentRunsByFlows({
      userId: "user-1",
      flows: [
        { flowType: "automation", flowId: AUTO_ID },
        { flowType: "playbook", flowId: PLAYBOOK_ID },
      ],
      perFlowLimit: 5,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(userVisibleWhere).toHaveBeenCalledTimes(2);
    expect(histories).toEqual([
      {
        flowType: "automation",
        flowId: AUTO_ID,
        runs: [
          expect.objectContaining({
            id: "run-a",
            status: "completed",
            startedAt: new Date("2026-07-31T00:00:00.000Z"),
          }),
        ],
      },
      {
        flowType: "playbook",
        flowId: PLAYBOOK_ID,
        runs: [],
      },
    ]);
  });

  it("deduplicates flow requests and does not query an unused ledger", async () => {
    execute.mockResolvedValueOnce([]);

    const histories = await listRecentRunsByFlows({
      userId: "user-1",
      flows: [
        { flowType: "automation", flowId: AUTO_ID },
        { flowType: "automation", flowId: AUTO_ID },
      ],
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(userVisibleWhere).toHaveBeenCalledTimes(1);
    expect(histories).toHaveLength(1);
  });

  it("keeps every running execution in addition to the bounded terminal history", async () => {
    execute.mockResolvedValueOnce([
      {
        id: "new-terminal",
        flowId: AUTO_ID,
        status: "failed",
        startedAt: "2026-07-31T12:00:00.000Z",
        completedAt: "2026-07-31T12:00:01.000Z",
      },
      {
        id: "old-running",
        flowId: AUTO_ID,
        status: "running",
        startedAt: "2026-07-30T00:00:00.000Z",
        completedAt: null,
      },
    ]);

    const histories = await listRecentRunsByFlows({
      userId: "user-1",
      flows: [{ flowType: "automation", flowId: AUTO_ID }],
      perFlowLimit: 1,
    });

    expect(histories[0]?.runs.map((run) => run.id)).toEqual([
      "new-terminal",
      "old-running",
    ]);
    const query = sqlText(execute.mock.calls[0]?.[0]);
    expect(query).toContain("count(*) FILTER");
    expect(query).toContain("WHERE status <> 'running'");
    expect(query).toContain("WHERE \"status\" = 'running'");
    expect(query).toContain("OR terminal_row_number <= ");
  });
});
