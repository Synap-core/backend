/**
 * Size budget for the DEFAULT call of `synap_list_automations` and
 * `synap_list_views`, driven through the REAL handlers with only the Hub caller
 * stubbed. Same contract as `read-lean.budget.test.ts`.
 *
 * WHY (measured on the live pod, 2026-09-19): `synap_list_automations
 * {limit:30}` returned 489,440 chars — almost all `flowDefinition` — and
 * `synap_list_views` returned 81 KB (65 views, `config` ≈ 3.5 KB each). Both
 * are past every client's tool-output cap, so an agent that wanted an id got
 * nothing it could read.
 *
 * Reachability, not shape: the lean output still names every id, name and
 * status. Non-vacuity: the fixture's `detail:'full'` output exceeds the budget
 * and still carries the heavy field the digest drops.
 *
 * WHAT THIS DOES NOT COVER: a pod whose automation or view COUNT alone exceeds
 * the budget — that is paging, not projection.
 */

import { describe, it, expect } from "vitest";
import { capabilityHandlers } from "./capability.js";
import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";

const BUDGET_CHARS = 40_000;

// Live-sized fixture: 30 automations averaging ~16 KB of flow graph.
const automations = Array.from({ length: 30 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  workspaceId: null,
  createdBy: "user-1",
  name: `Automation ${i}`,
  description: "Recap every client each morning and post it to the channel.",
  triggerType: "cron",
  triggerConfig: { expression: "0 9 * * *" },
  flowDefinition: {
    nodes: Array.from({ length: 40 }, (_, n) => ({
      id: `n${n}`,
      type: "capability",
      data: { verbId: "ai.generate", prompt: "x".repeat(350) },
    })),
    edges: [],
  },
  status: "active",
  errorMessage: null,
  version: 1,
  lastRunAt: "2026-09-18T09:00:00.000Z",
  nextRunAt: "2026-09-19T09:00:00.000Z",
  runCount: 12,
  successCount: 11,
  failureCount: 1,
  state: {},
  metadata: { dataContract: { version: 1 } },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-18T09:00:00.000Z",
}));

// Live-sized fixture: 65 views with a ~3.5 KB bento config each.
const views = Array.from({ length: 65 }, (_, i) => ({
  id: `11111111-0000-4000-8000-${String(i).padStart(12, "0")}`,
  workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  userId: "user-1",
  projectId: null,
  type: "bento",
  category: "composite",
  name: `View ${i}`,
  description: null,
  scopeProfileIds: null,
  scopeMode: "explicit",
  query: {},
  config: { blocks: [{ id: "b", config: { title: "y".repeat(3500) } }] },
  metadata: {},
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-18T09:00:00.000Z",
}));

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  const caller = {
    automations: { listAutomations: async () => ({ automations }) },
    views: { listViews: async () => views },
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

async function call(
  handler: ((c: McpToolContext) => Promise<unknown>) | undefined,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  if (!handler) throw new Error(`${toolName} handler missing`);
  const res = (await handler(ctx(toolName, args))) as {
    content: Array<{ text: string }>;
  };
  return res.content[0].text;
}

describe("synap_list_automations — default digest fits the budget", () => {
  const handler = capabilityHandlers.synap_list_automations;

  it("full output is over budget and carries the flow graph (non-vacuity)", async () => {
    const text = await call(handler, "synap_list_automations", {
      detail: "full",
    });
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);
    expect(text).toContain("flowDefinition");
  });

  it("default output is under budget and still names every automation", async () => {
    const text = await call(handler, "synap_list_automations", {});
    expect(text.length).toBeLessThan(BUDGET_CHARS);
    const out = JSON.parse(text);
    expect(out.automations).toHaveLength(automations.length);
    for (const a of automations) {
      const row = out.automations.find((r: { id: string }) => r.id === a.id);
      expect(row).toMatchObject({
        name: a.name,
        status: a.status,
        triggerType: a.triggerType,
      });
      expect(row).not.toHaveProperty("flowDefinition");
    }
    expect(out.note).toMatch(/detail:'full'/);
  });
});

describe("synap_list_views — default digest fits the budget", () => {
  const handler = buildHandlers.synap_list_views;

  it("full output is over budget and carries the layout config (non-vacuity)", async () => {
    const text = await call(handler, "synap_list_views", { detail: "full" });
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);
    expect(text).toContain('"config"');
  });

  it("default output is under budget and still names every view", async () => {
    const text = await call(handler, "synap_list_views", {});
    expect(text.length).toBeLessThan(BUDGET_CHARS);
    const out = JSON.parse(text);
    expect(out.views).toHaveLength(views.length);
    for (const v of views) {
      const row = out.views.find((r: { id: string }) => r.id === v.id);
      expect(row).toMatchObject({ name: v.name, type: v.type });
      expect(row).not.toHaveProperty("config");
    }
    expect(out.note).toMatch(/detail:'full'/);
  });
});
