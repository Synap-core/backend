/**
 * synap_match_playbooks — the auto-pick note says WHY, for the case that
 * happened.
 *
 * `resolveEntityWorkspaceId` auto-picks one member workspace both when NO
 * entityId was passed and when a passed entity's workspace cannot be resolved.
 * The note used to say "The entity's own workspace could not be resolved" in
 * both, so a caller that sent only intentText was told about an entity it
 * never sent. Driven through the real handler; only the catalog read, the
 * membership read and the entity row read are stubbed.
 */

import { describe, it, expect, vi } from "vitest";

const { matchForEntity } = vi.hoisted(() => ({
  matchForEntity: vi.fn(async () => [{ id: "pb-1", score: 1 }]),
}));

vi.mock("../../playbooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../playbooks.js")>()),
  playbooksRouter: { createCaller: () => ({ matchForEntity }) },
}));
vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("../../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/rest/_shared.js")
  >()),
  getUserMemberWorkspaceIds: vi.fn(async () => ["ws-1", "ws-2", "ws-3"]),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  // The entity is gone / pod-global: no workspace to resolve.
  db: { query: { entities: { findFirst: async () => undefined } } },
}));

import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const ENTITY = "99999999-2222-4333-8444-555555555555";

async function note(args: Record<string, unknown>): Promise<string> {
  const res = await buildHandlers.synap_match_playbooks!({
    toolName: "synap_match_playbooks",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  } as McpToolContext);
  const block = res.content?.[0] as { text: string };
  const body = JSON.parse(block.text) as {
    note: string;
    scopedWorkspaceId: string;
  };
  expect(body.scopedWorkspaceId).toBe("ws-1");
  return body.note;
}

describe("synap_match_playbooks — auto-pick note", () => {
  it("no entity given: says nothing was given, never blames an entity", async () => {
    const n = await note({ intentText: "write a post" });
    expect(n).toMatch(/No workspaceId or entityId was given/);
    expect(n).not.toMatch(/entity's own workspace could not be resolved/);
    expect(n).toContain("3 member workspaces");
  });

  it("entity given but unresolvable: says the ENTITY's workspace could not be resolved", async () => {
    const n = await note({ entityId: ENTITY });
    expect(n).toMatch(/entity's own workspace could not be resolved/);
    expect(n).not.toMatch(/No workspaceId or entityId was given/);
  });

  it("a projectId is named, and said NOT to choose the workspace", async () => {
    const n = await note({ intentText: "launch", projectId: PROJECT });
    expect(n).toContain(PROJECT);
    expect(n).toMatch(/does not choose the workspace/);
    expect(await note({ intentText: "launch" })).not.toContain("projectId");
  });
});
