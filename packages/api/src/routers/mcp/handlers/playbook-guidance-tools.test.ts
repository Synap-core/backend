/**
 * An agent can declare the rules a playbook follows over MCP (design b199a3a4,
 * slice 1b): `synap_create_playbook` and `synap_update_playbook` carry
 * `guidance` to the procedures, whose REAL input schemas
 * (`createInputSchema`, `updateInputSchema`: `playbookGuidanceSchema`) keep a
 * good list and refuse a bad ref. Before, both tools dropped it (#924
 * deviation 8).
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

const GUIDANCE = [
  {
    ref: "kind:brand-voice-guide",
    label: "Voice",
    where: { "voice-context": ["general", "outreach"] },
  },
  { ref: "kind:outreach-angle" },
  { ref: "skill:creative-director" },
];

describe("synap_create_playbook / synap_update_playbook carry guidance", () => {
  it("create forwards it, and the procedure's schema keeps it", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", {
        name: "Draft a first message",
        goalTemplate: "Draft it",
        guidance: GUIDANCE,
      })
    );
    expect(h.creates).toHaveLength(1);
    expect(createInputSchema.parse(h.creates[0]).guidance).toEqual(GUIDANCE);
  });

  it("update forwards it as a patch, and the procedure's schema keeps it", async () => {
    h.updates.length = 0;
    await buildHandlers.synap_update_playbook!(
      ctx("synap_update_playbook", {
        playbookId: "00000000-0000-4000-8000-0000000000cc",
        guidance: GUIDANCE,
      })
    );
    expect(h.updates).toHaveLength(1);
    expect(updateInputSchema.parse(h.updates[0]).guidance).toEqual(GUIDANCE);
  });

  it("a bad ref reaches the procedure's schema and is refused there, never dropped", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", {
        name: "Draft a first message",
        goalTemplate: "Draft it",
        guidance: [{ ref: "entity:1234" }],
      })
    );
    expect(h.creates[0]!.guidance).toEqual([{ ref: "entity:1234" }]);
    expect(createInputSchema.safeParse(h.creates[0]).success).toBe(false);
  });

  it("a playbook that declares no guidance sends none", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", { name: "Weekly", goalTemplate: "Review" })
    );
    expect("guidance" in h.creates[0]!).toBe(false);
  });

  it("both tools advertise guidance", async () => {
    const listed = await tools.list();
    for (const name of ["synap_create_playbook", "synap_update_playbook"]) {
      const tool = listed.find((t) => t.name === name)!;
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.guidance, name).toBeDefined();
    }
  });
});
