import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ctx: null as Record<string, unknown> | null,
  input: null as Record<string, unknown> | null,
  result: { status: "created", id: "d1" } as Record<string, unknown>,
}));
vi.mock("@synap/database", () => ({ db: { marker: "db" } }));
vi.mock("../../../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.ctx = ctx;
      return {
        create: async (input: Record<string, unknown>) => {
          h.input = input;
          return h.result;
        },
        update: async (input: Record<string, unknown>) => {
          h.input = input;
          return h.result;
        },
      };
    },
  },
}));

import {
  createDecisionEntity,
  updateDecisionEntity,
} from "../decision-entity-door.js";

const scope = { userId: "u1", workspaceId: "w1", sessionId: "s1" };

describe("the decision entity door", () => {
  beforeEach(() => {
    h.result = { status: "created", id: "d1" };
  });

  it("creates a `decision` through entities.create AS THE PERSON, in the session", async () => {
    const id = await createDecisionEntity(scope, {
      title: "Which account?",
      properties: { summary: "US" },
      projectId: "p1",
    });
    expect(id).toBe("d1");
    expect(h.ctx).toMatchObject({
      userId: "u1",
      workspaceId: "w1",
      sessionId: "s1",
    });
    expect(h.ctx).not.toHaveProperty("agentUserId");
    expect(h.input).toMatchObject({
      profileSlug: "decision",
      title: "Which account?",
      properties: { summary: "US" },
      targetWorkspaceId: "w1",
      projectId: "p1",
      forceCreate: true,
    });
  });

  it("anything but a created row THROWS — a proposal is not a filed decision", async () => {
    h.result = { status: "proposed", proposalId: "x" };
    await expect(
      createDecisionEntity(scope, { title: "t", properties: {} })
    ).rejects.toThrow(/did not land \(status: proposed\)/);
  });

  it("an update that was proposed THROWS", async () => {
    h.result = { status: "proposed" };
    await expect(updateDecisionEntity(scope, "d1", {})).rejects.toThrow(
      /did not land/
    );
    h.result = { status: "updated" };
    await updateDecisionEntity(scope, "d1", { a: 1 });
    expect(h.input).toEqual({ id: "d1", properties: { a: 1 } });
  });
});
