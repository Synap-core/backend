/**
 * An agent declares the phrases a playbook is FOR over MCP (plan a640c5bb D3):
 * `synap_create_playbook` and `synap_update_playbook` carry `triggers` to the
 * procedures as `metadata.triggers`, whose REAL input schemas
 * (`createInputSchema`, `updateInputSchema`: `playbookTriggersSchema`) keep a
 * good list and refuse a phrase no request can match. The ranker reads them
 * back (`playbookTriggers` → `RouteCandidate.triggers`).
 *
 * SEAM: the REAL MCP handlers → the REAL playbook doors → the input the
 * procedures receive. Only the router caller is stubbed (it needs a database).
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  creates: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../playbooks.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    playbooksRouter: {
      createCaller: () => ({
        create: async (input: Record<string, unknown>) => {
          h.creates.push(input);
          return { status: "proposed", proposalId: "p-1" };
        },
        update: async (input: Record<string, unknown>) => {
          h.updates.push(input);
          return { status: "proposed", proposalId: "p-2" };
        },
      }),
    },
  };
});

vi.mock("../../hub-protocol/utils.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createHubProtocolCallerContext: async () => ({}) };
});

import { buildHandlers } from "./build.js";
import { createInputSchema, updateInputSchema } from "../../playbooks.js";
import { tools } from "../tools/index.js";
import { playbookTriggers } from "../../../services/playbooks/playbook-search-text.js";
import type { McpToolContext } from "./shared.js";

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  return {
    toolName,
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "00000000-0000-4000-8000-0000000000bb",
    requestedWorkspaceId: "00000000-0000-4000-8000-0000000000aa",
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

const TRIGGERS = ["workspace hygiene", "build a feature"];

describe("synap_create_playbook / synap_update_playbook carry triggers", () => {
  it("create stores them as metadata.triggers, kept by the procedure's schema and read back by the ranker's reader", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", {
        name: "AI Dev Session",
        goalTemplate: "Run the dev task",
        triggers: TRIGGERS,
      })
    );
    expect(h.creates).toHaveLength(1);
    const parsed = createInputSchema.parse(h.creates[0]);
    expect(parsed.metadata?.triggers).toEqual(TRIGGERS);
    expect(playbookTriggers(parsed.metadata)).toEqual(TRIGGERS);
  });

  it("update sends a metadata patch holding only the triggers (the merge keeps every other key)", async () => {
    h.updates.length = 0;
    await buildHandlers.synap_update_playbook!(
      ctx("synap_update_playbook", {
        playbookId: "00000000-0000-4000-8000-0000000000cc",
        triggers: TRIGGERS,
      })
    );
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.metadata).toEqual({ triggers: TRIGGERS });
    expect(updateInputSchema.parse(h.updates[0]).metadata?.triggers).toEqual(
      TRIGGERS
    );
  });

  it("a phrase no request can match reaches the schemas and is refused there, never dropped", async () => {
    h.creates.length = 0;
    h.updates.length = 0;
    const bad = ["the work for this session"];
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", {
        name: "Weekly",
        goalTemplate: "Review",
        triggers: bad,
      })
    );
    await buildHandlers.synap_update_playbook!(
      ctx("synap_update_playbook", {
        playbookId: "00000000-0000-4000-8000-0000000000cc",
        triggers: bad,
      })
    );
    expect(createInputSchema.safeParse(h.creates[0]).success).toBe(false);
    expect(updateInputSchema.safeParse(h.updates[0]).success).toBe(false);
  });

  it("a playbook that declares no triggers sends no metadata", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", { name: "Weekly", goalTemplate: "Review" })
    );
    expect("metadata" in h.creates[0]!).toBe(false);
  });

  it("both tools advertise triggers", async () => {
    const listed = await tools.list();
    for (const name of ["synap_create_playbook", "synap_update_playbook"]) {
      const tool = listed.find((t) => t.name === name)!;
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.triggers, name).toBeDefined();
    }
  });
});
