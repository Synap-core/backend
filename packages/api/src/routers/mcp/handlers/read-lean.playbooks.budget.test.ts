/**
 * Size budget for the DEFAULT call of `synap_list_playbooks`, driven through
 * the REAL handler with only its reads stubbed (the list and get doors, the
 * scorecards). Same contract as `read-lean.list-doors.budget.test.ts`.
 *
 * WHY (measured on the founder's pod, build 62da6fd2, 2026-11-05, finding
 * bce5f941): 7 Content OS playbooks came back as 67,855 chars, 26 fields
 * each. The founder's rule: an AI-facing list returns the id, name, status and
 * the kind's key fields; the full object comes from a get.
 *
 * Reachability, not shape: the digest still names every id, name and status,
 * the params a run must answer and the activator keys a worker takes; ONE
 * playbook comes back in full through `playbookId` (the get door). Non-vacuity:
 * the fixture's `detail:'full'` output exceeds the budget and still carries
 * the heavy fields the digest drops.
 *
 * NOT COVERED: a pod whose playbook COUNT alone exceeds the budget (paging).
 */

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ gets: [] as string[] }));

// Live-sized fixture: 7 playbooks of ~9.7 KB each, the founder's measured mean.
const playbooks = Array.from({ length: 7 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  workspaceId: "11111111-1111-4111-8111-111111111111",
  createdBy: "user-1",
  name: `Process ${i}`,
  description:
    "Reads the idea bank and proposes posts, each linked to its ideas. ".repeat(
      4
    ),
  goalTemplate: "Package {post} for @{arg:platform}. ".repeat(40),
  params: [
    {
      name: "post",
      type: "entity",
      required: true,
      description: "x".repeat(200),
    },
    {
      name: "platform",
      type: "text",
      required: true,
      description: "x".repeat(200),
    },
    { name: "format", type: "text", description: "x".repeat(200) },
  ],
  inputStrategy: { kind: "none", description: "x".repeat(300) },
  channelSpec: { description: "x".repeat(300) },
  expectedOutputs: Array.from({ length: 6 }, () => ({
    kind: "document",
    description: "x".repeat(250),
  })),
  stages: Array.from({ length: 6 }, (_, s) => ({
    key: `s${s}`,
    name: `Stage ${s}`,
    instructions: "x".repeat(500),
  })),
  criteria: Array.from({ length: 5 }, (_, c) => ({
    key: `c${c}`,
    statement: "x".repeat(200),
    check: { kind: "judge" },
  })),
  requiredIntents: [],
  version: 3,
  schedule: null,
  executor: "is-agent",
  status: "active",
  scope: "session",
  flowAutomationId: null,
  subjectProfile: {
    profileSlug: "post",
    activators: [
      {
        on: "enters_status",
        status: "Idea",
        size: "per_thing",
        mode: "propose",
      },
    ],
  },
  metadata: { notes: "x".repeat(400) },
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-05T10:00:00.000Z",
}));

vi.mock("../../hub-protocol/playbook-doors.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listPlaybooksDoor: async () => ({ playbooks, nextCursor: null }),
    getPlaybookDoor: async (_identity: unknown, id: string) => {
      h.gets.push(id);
      const row = playbooks.find((p) => p.id === id);
      return row
        ? { kind: "result", result: row }
        : { kind: "not_found", error: `Playbook ${id} not found` };
    },
  };
});
vi.mock("@synap/jobs/utils/playbook-scorecard.js", () => ({
  computePlaybookScorecards: async (
    _db: unknown,
    p: { playbookIds: string[] }
  ) => Object.fromEntries(p.playbookIds.map((id) => [id, null])),
  compactScorecard: () => null,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getDb: async () => ({}) };
});

import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";

const BUDGET_CHARS = 8_000;

const call = async (args: Record<string, unknown>) => {
  const res = await buildHandlers.synap_list_playbooks!({
    toolName: "synap_list_playbooks",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
  } as unknown as McpToolContext);
  const text = (res.content[0] as { text: string }).text;
  return { text, body: JSON.parse(text) as Record<string, unknown> };
};

describe("synap_list_playbooks — the default call is a digest", () => {
  it("fits the budget and still names every playbook, what a run must answer and its activators", async () => {
    const { text, body } = await call({});
    expect(text.length).toBeLessThan(BUDGET_CHARS);
    const rows = body.playbooks as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(playbooks.map((p) => p.id));
    expect(rows[0]).toMatchObject({
      name: "Process 0",
      status: "active",
      executor: "is-agent",
      params: ["post", "platform", "format"],
      requiredParams: ["post", "platform"],
    });
    expect(
      (rows[0]!.activators as Array<{ key: string }>)[0]!.key
    ).toBeTruthy();
    for (const heavy of [
      "goalTemplate",
      "stages",
      "criteria",
      "expectedOutputs",
      "channelSpec",
      "metadata",
    ]) {
      expect(rows[0]).not.toHaveProperty(heavy);
    }
    expect(String(rows[0]!.description)).toMatch(
      /…\[truncated: \d+ chars total\]$/
    );
    expect(body.note).toMatch(/playbookId/);
  });

  it("non-vacuity: detail:'full' is over the budget and carries the heavy fields", async () => {
    const { text, body } = await call({ detail: "full" });
    expect(text.length).toBeGreaterThan(BUDGET_CHARS * 4);
    expect(
      (body.playbooks as Array<Record<string, unknown>>)[0]
    ).toHaveProperty("stages");
  });

  it("playbookId reads ONE playbook in full, through the get door", async () => {
    h.gets.length = 0;
    const id = playbooks[2]!.id;
    const { body } = await call({ playbookId: ` ${id} ` });
    expect(h.gets).toEqual([id]);
    expect(body).toMatchObject({ id, name: "Process 2" });
    expect(body).toHaveProperty("stages");
    expect(body).toHaveProperty("goalTemplate");
  });
});
