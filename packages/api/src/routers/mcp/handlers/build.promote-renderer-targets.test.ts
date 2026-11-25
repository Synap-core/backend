/**
 * synap_promote_cell_to_renderer — ONE door for every renderer target.
 *
 * Driven through the real handler. The two doors behind it are stubbed at
 * their seam: the Hub `profiles.setRenderer` caller (renderer_bindings:
 * a kind's records, a playbook, a view) and `bindCapabilityRenderer` (a
 * capability's page-set). What is pinned is the DISPATCH: which door each
 * target reaches, with which subject, and that a capability's other pages
 * survive a one-page bind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  setRenderer: vi.fn(),
  bindCapabilityRenderer: vi.fn(),
  readBoundRenderer: vi.fn(),
  assertRendererTargetVisible: vi.fn(),
  assertCellBindable: vi.fn(),
}));

vi.mock(
  "../../../services/capabilities/bind-capability-renderer.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    bindCapabilityRenderer: calls.bindCapabilityRenderer,
  })
);
vi.mock("../../../services/renderers/renderer-target-checks.js", () => ({
  assertRendererTargetVisible: calls.assertRendererTargetVisible,
  assertCellBindable: calls.assertCellBindable,
  cellRendererRefFor: async (cellKey: string) => ({
    kind: "cell",
    cellKey,
    props: {},
  }),
  readBoundRenderer: calls.readBoundRenderer,
}));

import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";

const CAP = "11111111-1111-4111-8111-111111111111";
const PLAYBOOK = "22222222-2222-4222-8222-222222222222";

const ctx = (args: Record<string, unknown>): McpToolContext =>
  ({
    toolName: "synap_promote_cell_to_renderer",
    args,
    userId: "user-1",
    agentUserId: "agent-1",
    apiKeyScopes: ["mcp.write"],
    caller: {
      profiles: { setRenderer: calls.setRenderer },
    } as unknown as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  }) as McpToolContext;

async function call(args: Record<string, unknown>) {
  const result = await buildHandlers.synap_promote_cell_to_renderer!(ctx(args));
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return { isError: result.isError === true, text: block.text };
}

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.setRenderer.mockResolvedValue({
    status: "proposed",
    proposalId: "p-1",
  });
  calls.bindCapabilityRenderer.mockResolvedValue({
    status: "proposed",
    proposalId: "p-2",
  });
});

describe("synap_promote_cell_to_renderer — one door, four targets", () => {
  it("profileSlug (the older input) still binds a kind's records", async () => {
    await call({
      profileSlug: "deal",
      slot: "card",
      cellKey: "generated:deal-card",
    });
    expect(calls.setRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSlug: "deal",
        slot: "card",
        cellKey: "generated:deal-card",
        agentUserId: "agent-1",
      })
    );
    expect(calls.setRenderer.mock.calls[0]![0]).not.toHaveProperty("subjectId");
  });

  it("a playbook target binds THAT playbook's detail in renderer_bindings", async () => {
    await call({
      target: { kind: "playbook", id: PLAYBOOK },
      slot: "detail",
      cellKey: "generated:lead-board",
      scope: "pod",
    });
    expect(calls.setRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSlug: "playbook",
        subjectId: PLAYBOOK,
        slot: "detail",
        scope: "pod",
      })
    );
    expect(calls.bindCapabilityRenderer).not.toHaveBeenCalled();
  });

  it("a capability target reaches the capability page-set door and keeps its other pages", async () => {
    await call({
      target: { kind: "capability", id: CAP },
      slot: "detail",
      cellKey: "generated:cap-page",
      scope: "pod",
      reasoning: "the founder asked for it",
    });
    expect(calls.setRenderer).not.toHaveBeenCalled();
    expect(calls.assertRendererTargetVisible).toHaveBeenCalledWith(
      { kind: "capability", id: CAP },
      "user-1"
    );
    const input = calls.bindCapabilityRenderer.mock.calls[0]![0];
    expect(input).toMatchObject({
      capabilityId: CAP,
      // a capability's `pod` renderer is its own default
      scope: "capability",
      agentUserId: "agent-1",
      reasoning: "the founder asked for it",
    });
    const dashboard = {
      slot: "dashboard",
      title: "Dashboard",
      ref: { kind: "cell", cellKey: "google-workspace", props: {} },
    };
    expect(input.pages([dashboard])).toEqual([
      dashboard,
      {
        slot: "detail",
        title: "Detail",
        ref: { kind: "cell", cellKey: "generated:cap-page", props: {} },
      },
    ]);
  });

  it("clear: true unbinds one capability page and only that one", async () => {
    await call({
      target: { kind: "capability", id: CAP },
      slot: "detail",
      clear: true,
      scope: "workspace",
      workspaceId: "33333333-3333-4333-8333-333333333333",
    });
    expect(calls.assertCellBindable).not.toHaveBeenCalled();
    const input = calls.bindCapabilityRenderer.mock.calls[0]![0];
    expect(input.scope).toBe("workspace");
    const keep = {
      slot: "dashboard",
      title: "Dashboard",
      ref: { kind: "cell", cellKey: "a", props: {} },
    };
    const drop = {
      slot: "detail",
      title: "Detail",
      ref: { kind: "cell", cellKey: "b", props: {} },
    };
    expect(input.pages([keep, drop])).toEqual([keep]);
  });

  it("refuses a slot the target does not have, before any door", async () => {
    const out = await call({
      target: { kind: "view", id: PLAYBOOK },
      slot: "card",
      cellKey: "generated:x",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/A view has no 'card' renderer slot/);
    expect(calls.setRenderer).not.toHaveBeenCalled();
  });

  it("refuses a capability renderer at scope 'user'", async () => {
    const out = await call({
      target: { kind: "capability", id: CAP },
      slot: "detail",
      cellKey: "generated:x",
      scope: "user",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/scope 'user'/);
    expect(calls.bindCapabilityRenderer).not.toHaveBeenCalled();
  });

  it("refuses neither cellKey nor clear, and both target and profileSlug", async () => {
    expect((await call({ profileSlug: "deal", slot: "detail" })).isError).toBe(
      true
    );
    expect(
      (
        await call({
          profileSlug: "deal",
          target: { kind: "view", id: PLAYBOOK },
          slot: "detail",
          cellKey: "generated:x",
        })
      ).isError
    ).toBe(true);
    expect(calls.setRenderer).not.toHaveBeenCalled();
  });

  it("an applied bind reads back what the target shows now", async () => {
    calls.setRenderer.mockResolvedValue({
      status: "applied",
      proposalId: null,
    });
    calls.readBoundRenderer.mockResolvedValue({
      ref: { kind: "cell", cellKey: "generated:lead-board", props: {} },
      source: "pod",
    });
    const out = await call({
      target: { kind: "playbook", id: PLAYBOOK },
      slot: "detail",
      cellKey: "generated:lead-board",
      scope: "pod",
    });
    expect(calls.readBoundRenderer).toHaveBeenCalledWith({
      target: { kind: "playbook", id: PLAYBOOK },
      slot: "detail",
      userId: "user-1",
      workspaceId: null,
    });
    expect(JSON.parse(out.text).nowBound.ref.cellKey).toBe(
      "generated:lead-board"
    );
  });
});
