/**
 * PAGING of the list doors that had none (finding "Five list tools have no
 * paging"): `synap_list_views`, `synap_list_automations`, `synap_list_widgets`,
 * `synap_list_proposals`, `synap_list_playbooks`, driven through the REAL
 * handlers with only their reads stubbed.
 *
 * WHY: on the founder's pod (measured 2026-11-09 through the live MCP door) a
 * default `synap_list_views` was 93,691 chars (~400 digest rows of ~230 chars),
 * `synap_list_automations` 23,921, `synap_list_playbooks` 24,368,
 * `synap_list_widgets` 47,206: past the 16,000-char reply cap, so the caller got
 * a CUT reply and no way to page. Now a default call is one page that fits the
 * cap, with `total` / `offset` / `nextOffset` (or `nextCursor`) to continue.
 *
 * Reachability, not shape: each door is walked page by page to the end and the
 * union is every row, once, with no `nextOffset` on the last page.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  proposalCalls: [] as Array<Record<string, unknown>>,
  playbookCalls: [] as Array<Record<string, unknown>>,
  automationCalls: [] as Array<Record<string, unknown>>,
}));

const PROPOSALS = Array.from({ length: 45 }, (_, i) => ({
  id: `prop-${String(i).padStart(3, "0")}`,
  proposalType: "entity.create",
  targetType: "entity",
  targetId: `t${i}`,
  status: "pending",
  workspaceId: null,
  correlationId: null,
  sessionId: null,
  agentUserId: "agent-1",
  data: { operations: [] },
}));

vi.mock(
  "../../../services/proposals/proposals-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    // Honours limit + offset like the real query.
    listCreatedProposals: vi.fn(
      async (p: { limit?: number; offset?: number }) => {
        h.proposalCalls.push(p);
        const o = p.offset ?? 0;
        return PROPOSALS.slice(o, o + (p.limit ?? 20));
      }
    ),
  })
);
vi.mock("../../hub-protocol/playbook-doors.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPlaybooksDoor: async (_i: unknown, input: Record<string, unknown>) => {
    h.playbookCalls.push(input);
    return { playbooks: [], nextCursor: "c1" };
  },
}));
vi.mock("@synap/jobs/utils/playbook-scorecard.js", () => ({
  computePlaybookScorecards: async () => ({}),
  compactScorecard: () => null,
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDb: async () => ({}),
}));

import { readHandlers } from "./read.js";
import { buildHandlers } from "./build.js";
import { capabilityHandlers } from "./capability.js";
import { REPLY_CAP_CHARS } from "../reply-cap.js";
import type { McpToolContext } from "./shared.js";

const VIEWS = Array.from({ length: 120 }, (_, i) => ({
  id: `11111111-0000-4000-8000-${String(i).padStart(12, "0")}`,
  workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  projectId: null,
  type: "kanban",
  category: "structured",
  name: `View ${i}`,
  scopeProfileIds: ["4921ec32-409c-4e8b-8ff5-77be2409b874"],
  updatedAt: "2026-11-08T21:39:39.089Z",
  config: { big: "x".repeat(2000) },
}));

const AUTOMATIONS = Array.from({ length: 60 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  name: `Automation ${i}`,
  description: "Recap every client each morning and post it to the channel.",
  triggerType: "cron",
  status: "active",
  updatedAt: "2026-09-18T09:00:00.000Z",
  flowDefinition: { nodes: [{ data: "x".repeat(500) }], edges: [] },
}));

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  const caller = {
    views: { listViews: async () => VIEWS },
    automations: {
      // Honours limit + offset like the real `ORDER BY … LIMIT … OFFSET`.
      listAutomations: async (i: { limit?: number; offset?: number }) => {
        h.automationCalls.push(i);
        const o = i.offset ?? 0;
        return { automations: AUTOMATIONS.slice(o, o + (i.limit ?? 50)) };
      },
    },
    widgetDefinitions: { listWidgetDefs: async () => [] },
  };
  return {
    toolName,
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller,
    lensCaller: caller,
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

async function run(
  handler: ((c: McpToolContext) => Promise<unknown>) | undefined,
  toolName: string,
  args: Record<string, unknown> = {}
) {
  if (!handler) throw new Error(`${toolName} handler missing`);
  const res = (await handler(ctx(toolName, args))) as {
    content: Array<{ text: string }>;
  };
  const text = res.content[0]!.text;
  return { text, body: JSON.parse(text) as Record<string, any> };
}

/** Walk a door to its last page; returns every row id in order. */
async function walk(
  handler: Parameters<typeof run>[0],
  toolName: string,
  key: string,
  idOf: (r: any) => string,
  base: Record<string, unknown> = {}
) {
  const ids: string[] = [];
  let offset: number | undefined = 0;
  let pages = 0;
  while (offset !== undefined) {
    const { body } = await run(handler, toolName, { ...base, offset });
    ids.push(...(body[key] as unknown[]).map(idOf));
    offset = body.nextOffset;
    if (++pages > 100) throw new Error("paging never ended");
  }
  return { ids, pages };
}

describe("synap_list_views pages", () => {
  const h0 = buildHandlers.synap_list_views;
  it("a default call is one page under the reply cap, naming the total and the next offset", async () => {
    const { text, body } = await run(h0, "synap_list_views");
    expect(body.views).toHaveLength(50);
    expect(body).toMatchObject({ total: 120, offset: 0, nextOffset: 50 });
    expect(text.length).toBeLessThan(REPLY_CAP_CHARS);
  });
  it("walking nextOffset yields every view once; the last page has no nextOffset", async () => {
    const { ids, pages } = await walk(
      h0,
      "synap_list_views",
      "views",
      (r) => r.id
    );
    expect(ids).toEqual(VIEWS.map((v) => v.id));
    expect(pages).toBe(3);
    const last = await run(h0, "synap_list_views", { offset: 100 });
    expect(last.body).not.toHaveProperty("nextOffset");
  });
  it("limit is honoured and capped at 200; detail:'full' pages too", async () => {
    expect(
      (await run(h0, "synap_list_views", { limit: 7 })).body.views
    ).toHaveLength(7);
    expect(
      (await run(h0, "synap_list_views", { limit: 9999 })).body.views
    ).toHaveLength(120);
    const full = await run(h0, "synap_list_views", {
      detail: "full",
      limit: 3,
    });
    expect(full.body.views).toHaveLength(3);
    expect(full.body.views[0]).toHaveProperty("config");
    expect(full.body.nextOffset).toBe(3);
  });
});

describe("synap_list_automations pages", () => {
  const h0 = capabilityHandlers.synap_list_automations;
  it("a default call asks for one page (+1 to peek) and answers 25 rows with nextOffset", async () => {
    h.automationCalls.length = 0;
    const { body } = await run(h0, "synap_list_automations");
    expect(h.automationCalls[0]).toMatchObject({ limit: 26, offset: 0 });
    expect(body.automations).toHaveLength(25);
    expect(body.nextOffset).toBe(25);
  });
  it("walking nextOffset yields every automation once", async () => {
    const { ids } = await walk(
      h0,
      "synap_list_automations",
      "automations",
      (r) => r.id
    );
    expect(ids).toEqual(AUTOMATIONS.map((a) => a.id));
  });
  it("an exact final page carries no nextOffset", async () => {
    const { body } = await run(h0, "synap_list_automations", {
      limit: 20,
      offset: 40,
    });
    expect(body.automations).toHaveLength(20);
    expect(body).not.toHaveProperty("nextOffset");
  });
});

describe("synap_list_proposals pages", () => {
  const h0 = readHandlers.synap_list_proposals;
  it("passes limit+1 and offset to the query, answers one page with nextOffset", async () => {
    h.proposalCalls.length = 0;
    const { body } = await run(h0, "synap_list_proposals", {
      limit: 10,
      offset: 10,
    });
    expect(h.proposalCalls[0]).toMatchObject({ limit: 11, offset: 10 });
    expect(body.proposals).toHaveLength(10);
    expect(body.nextOffset).toBe(20);
  });
  it("walking nextOffset yields every proposal once", async () => {
    const { ids } = await walk(
      h0,
      "synap_list_proposals",
      "proposals",
      (r) => r.id,
      {
        limit: 20,
      }
    );
    expect(ids).toEqual(PROPOSALS.map((p) => p.id));
  });
});

describe("synap_list_widgets pages", () => {
  const h0 = buildHandlers.synap_list_widgets;
  it("a default call is one page; walking yields the whole catalog once", async () => {
    const first = await run(h0, "synap_list_widgets");
    expect(first.body.widgets.length).toBeGreaterThan(0);
    expect(first.body.widgets.length).toBeLessThanOrEqual(15);
    expect(first.body.total).toBeGreaterThan(15);
    expect(first.body.nextOffset).toBe(first.body.widgets.length);
    const { ids } = await walk(
      h0,
      "synap_list_widgets",
      "widgets",
      (r) => r.key
    );
    expect(ids).toHaveLength(first.body.total);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("synap_list_playbooks pages by cursor", () => {
  const h0 = buildHandlers.synap_list_playbooks;
  it("defaults to a page of 25 (was the door's 50) and passes the cursor through", async () => {
    h.playbookCalls.length = 0;
    const { body } = await run(h0, "synap_list_playbooks");
    expect(h.playbookCalls[0]).toMatchObject({ limit: 25 });
    expect(body.nextCursor).toBe("c1");
    await run(h0, "synap_list_playbooks", { cursor: "c1", limit: 5 });
    expect(h.playbookCalls[1]).toMatchObject({ limit: 5, cursor: "c1" });
  });
});
