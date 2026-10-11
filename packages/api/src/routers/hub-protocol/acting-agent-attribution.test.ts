/**
 * Attribution forgery: a key that is NOT an agent naming an arbitrary agent in
 * the body (`agentUserId`) used to have every write governed — and attributed —
 * as that agent (its rules, trust, cap and scorecard). `actingAgentUserId` now
 * accepts a body id only for an agent of the key's own person; the
 * authenticated agent (ctx, then the request scope) always wins over a body.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Array<Record<string, unknown>>>,
  podAdmin: false,
}));

vi.mock("@synap/database", async (orig) => {
  const actual = await orig<typeof import("@synap/database")>();
  const chain = () => {
    const q = {
      from: () => q,
      where: () => q,
      limit: async () => h.rows.shift() ?? [],
    };
    return q;
  };
  return { ...actual, db: { select: () => chain() } };
});
vi.mock("../../utils/workspace-role.js", () => ({
  isPodAdmin: async () => h.podAdmin,
}));

import { runWithActingAgent } from "@synap/database";
import { actingAgentUserId } from "./utils.js";
import { agentBelongsTo } from "./agent-belongs-to.js";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const MINE = "22222222-2222-4222-8222-222222222222";
const THEIRS = "33333333-3333-4333-8333-333333333333";
const KEY_AGENT = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  h.rows = [];
  h.podAdmin = false;
});

describe("actingAgentUserId — who a hub write is governed as", () => {
  it("the authenticated agent (ctx) wins over any body id, with no lookup", async () => {
    h.rows = [[{ id: "boom" }]];
    await expect(
      actingAgentUserId({ agentUserId: KEY_AGENT, userId: HUMAN }, THEIRS)
    ).resolves.toBe(KEY_AGENT);
    expect(h.rows).toHaveLength(1);
  });

  it("the request's acting agent wins over a body id", async () => {
    await expect(
      runWithActingAgent(KEY_AGENT, () =>
        actingAgentUserId({ userId: HUMAN }, THEIRS)
      )
    ).resolves.toBe(KEY_AGENT);
  });

  it("a person's key may attribute to its own agent", async () => {
    h.rows = [[{ id: MINE, createdByUserId: HUMAN }]];
    await expect(actingAgentUserId({ userId: HUMAN }, MINE)).resolves.toBe(
      MINE
    );
  });

  it("a person's key naming someone else's agent is REFUSED", async () => {
    h.rows = [[{ id: THEIRS, createdByUserId: OTHER }], []];
    await expect(
      actingAgentUserId({ userId: HUMAN }, THEIRS)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a body id that is not an agent at all is refused", async () => {
    h.rows = [[]];
    await expect(
      actingAgentUserId({ userId: HUMAN }, OTHER)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("no body id and no agent: an operator write (undefined)", async () => {
    await expect(actingAgentUserId({ userId: HUMAN })).resolves.toBeUndefined();
  });
});

describe("agentBelongsTo", () => {
  it("an active key linking the agent to the person counts", async () => {
    h.rows = [[{ id: THEIRS, createdByUserId: OTHER }], [{ id: "key" }]];
    expect(await agentBelongsTo(HUMAN, THEIRS)).toBe(true);
  });

  it("an owner-less system agent: pod admin only", async () => {
    h.rows = [[{ id: THEIRS, createdByUserId: null }], []];
    expect(await agentBelongsTo(HUMAN, THEIRS)).toBe(false);
    h.podAdmin = true;
    h.rows = [[{ id: THEIRS, createdByUserId: null }], []];
    expect(await agentBelongsTo(HUMAN, THEIRS)).toBe(true);
  });

  it("another person's agent is not attributable even by a pod admin", async () => {
    h.podAdmin = true;
    h.rows = [[{ id: THEIRS, createdByUserId: OTHER }], []];
    expect(await agentBelongsTo(HUMAN, THEIRS)).toBe(false);
  });
});
