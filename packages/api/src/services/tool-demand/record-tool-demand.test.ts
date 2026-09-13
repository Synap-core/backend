/**
 * recordToolDemand — the one tool-demand door.
 *
 * Real: normalization, the dedup decision, the property payload, the governed
 * caller contract (agentUserId threaded), the forward enqueue.
 * Stubbed: the `tool_request` lookup (a queued row per test) and pg-boss.
 * The governed caller is a fake that answers like `entities.create/update`:
 * an agent write → proposed, a human write → created/updated.
 *
 * NOT covered here: the real entities door on a database (typecheck only).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  lookupRows: [] as Array<{ id: string; properties: unknown }>,
  send: vi.fn(async () => "job-1"),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => h.lookupRows,
  };
  return {
    ...actual,
    db: { select: () => chain },
    profileSlugScopeCondition: async () =>
      (actual.drizzleSql as (s: TemplateStringsArray) => unknown)`true`,
  };
});

vi.mock("../../utils/workspace-membership.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveFacetVisibilityScope: async (userId: string) => ({ userId }),
}));

vi.mock("@synap/jobs", () => ({ getBoss: () => ({ send: h.send }) }));

import {
  recordToolDemand,
  type ToolDemandCaller,
} from "./record-tool-demand.js";
import { TOOL_DEMAND_FORWARD_QUEUE } from "@synap-core/types/tools";

function fakeCaller() {
  const create = vi.fn(async (input: { agentUserId?: string }) =>
    input.agentUserId
      ? { status: "proposed", proposalId: "p-1", reviewUrl: "/r/p-1" }
      : { status: "created", id: "e-new" }
  );
  const update = vi.fn(async (input: { agentUserId?: string }) =>
    input.agentUserId
      ? { status: "proposed", proposalId: "p-2" }
      : { status: "created" }
  );
  return {
    caller: { create, update } as unknown as ToolDemandCaller,
    create,
    update,
  };
}

beforeEach(() => {
  h.lookupRows = [];
  h.send.mockClear();
});

describe("recordToolDemand", () => {
  it("creates ONE governed tool_request and enqueues the forward", async () => {
    const { caller, create, update } = fakeCaller();
    const r = await recordToolDemand({
      caller,
      userId: "u-1",
      toolName: "Google Calendar",
      source: "onboarding",
    });
    expect(r).toMatchObject({
      status: "created",
      normalizedKey: "google-calendar",
      entityId: "e-new",
    });
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      profileSlug: "tool_request",
      title: "Google Calendar",
    });
    // EXACTLY these properties — no provider key or other caller text is stored.
    expect(
      (create.mock.calls[0]![0] as { properties: object }).properties
    ).toEqual({
      tr_normalized_key: "google-calendar",
      tr_status: "wanted",
      tr_sources: ["onboarding"],
    });
    expect(h.send).toHaveBeenCalledWith(
      TOOL_DEMAND_FORWARD_QUEUE,
      {},
      expect.anything()
    );
  });

  it("never duplicates: an existing record with this source is a no-op", async () => {
    h.lookupRows = [
      {
        id: "e-1",
        properties: { tr_normalized_key: "notion", tr_sources: ["onboarding"] },
      },
    ];
    const { caller, create, update } = fakeCaller();
    const r = await recordToolDemand({
      caller,
      userId: "u-1",
      toolName: "NOTION",
      source: "onboarding",
    });
    expect(r).toMatchObject({ status: "already-recorded", entityId: "e-1" });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("merges a NEW source into the existing record through the governed update", async () => {
    h.lookupRows = [
      {
        id: "e-1",
        properties: { tr_normalized_key: "notion", tr_sources: ["onboarding"] },
      },
    ];
    const { caller, create, update } = fakeCaller();
    const r = await recordToolDemand({
      caller,
      userId: "u-1",
      toolName: "Notion",
      source: "market_search_miss",
    });
    expect(r).toMatchObject({ status: "updated", entityId: "e-1" });
    expect(create).not.toHaveBeenCalled();
    expect(update.mock.calls[0]![0]).toMatchObject({
      id: "e-1",
      properties: { tr_sources: ["onboarding", "market_search_miss"] },
    });
  });

  it("an agent's demand is PROPOSED (agentUserId reaches the door) and not forwarded yet", async () => {
    const { caller, create } = fakeCaller();
    const r = await recordToolDemand({
      caller,
      userId: "u-1",
      toolName: "Linear",
      source: "market_search_miss",
      agentUserId: "agent-1",
    });
    expect(create.mock.calls[0]![0]).toMatchObject({ agentUserId: "agent-1" });
    expect(r).toMatchObject({
      status: "proposed",
      proposalId: "p-1",
      entityId: null,
    });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("an unusable name writes nothing", async () => {
    const { caller, create } = fakeCaller();
    const r = await recordToolDemand({
      caller,
      userId: "u-1",
      toolName: "???",
      source: "onboarding",
    });
    expect(r.status).toBe("invalid-name");
    expect(create).not.toHaveBeenCalled();
  });
});
