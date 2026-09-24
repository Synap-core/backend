/**
 * `scope` reaches `playbooks.create` from the AGENT doors (0272 follow-up).
 *
 * A track runs a METHOD — a playbook with `scope: "project"`. Before this, no
 * agent door carried `scope`: `synap_create_playbook` and Hub `POST /playbooks`
 * both went through `createPlaybookDoor`, which dropped it, so an agent could
 * only ever create a SESSION playbook and could never author what a track runs.
 *
 * SEAM: the REAL MCP handler → the REAL `createPlaybookDoor` → the input the
 * `playbooks.create` procedure receives, parsed by that procedure's REAL input
 * schema (`createInputSchema`) — the schema whose output is stored on the row
 * (`scope: input.scope`) and on the proposal (`scope: input.scope ?? null`).
 * Only the router caller is stubbed (it needs a database).
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ creates: [] as Array<Record<string, unknown>> }));

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
      }),
    },
  };
});

vi.mock("../../hub-protocol/utils.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createHubProtocolCallerContext: async () => ({}) };
});

import { buildHandlers } from "./build.js";
import { createInputSchema } from "../../playbooks.js";
import type { McpToolContext } from "./shared.js";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_create_playbook",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "00000000-0000-4000-8000-0000000000bb",
    requestedWorkspaceId: "00000000-0000-4000-8000-0000000000aa",
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

describe("synap_create_playbook → scope", () => {
  it("carries scope: 'project' to playbooks.create, and the procedure's schema keeps it", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx({ name: "Business model", goalTemplate: "Run it", scope: "project" })
    );
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.scope).toBe("project");
    const parsed = createInputSchema.parse(h.creates[0]);
    expect(parsed.scope).toBe("project");
  });

  it("omitted scope stays omitted (reads as session — nothing reclassifies itself)", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx({ name: "Weekly", goalTemplate: "Review" })
    );
    expect("scope" in h.creates[0]!).toBe(false);
  });
});
