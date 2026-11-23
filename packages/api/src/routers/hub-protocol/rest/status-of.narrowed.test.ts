/**
 * Hub REST `GET /status-of` for a key NARROWED by its grant (a pod app pinned
 * to spaces): the route asks `statusOfReach` and
 *  - reads only the parts that touch the subject's own record (`moves`,
 *    `history`) and the floored `work` projection, and names the others as
 *    withheld;
 *  - cuts every answer back to the status (no waitingOn, nextMove...) and
 *    `work` to its allow-list (D7): a gate's proposal only when the proposal
 *    floor reads it, an agent's name only with `agent.read`;
 *  - leaves a person, and a key reading every subject, whole;
 *  - refuses a bad ids list (400) before reading anything.
 *
 * DB-free: `readStatusOf` is stubbed to record what it was asked; the grant
 * floor on each id is proven on real SQL in
 * `services/status/__tests__/status-realtime.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { runWithGrant } from "@synap/database";

const h = vi.hoisted(() => ({
  calls: [] as unknown[][],
  // The gate proposals the proposal floor reads for this key.
  readable: new Set<string>(),
  work: undefined as unknown,
}));
const FULL_ANSWER = {
  id: "e1",
  type: "entity",
  name: "A piece",
  status: "draft",
  waitingOn: [{ kind: "person" }],
  nextMove: { kind: "x" },
  work: { items: [] },
  roles: [],
  history: {
    events: [
      {
        id: "w1",
        kind: "wait_episode",
        at: "t",
        on: "proposal",
        reason: "waits",
        ref: { kind: "proposal", id: "foreign-id", url: "u", label: "Foreign" },
      },
    ],
    truncated: false,
  },
  link: "l",
};

vi.mock("../../../services/status/status-read.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    readStatusOf: async (...args: unknown[]) => {
      h.calls.push(args);
      return [
        h.work ? { ...FULL_ANSWER, work: h.work } : FULL_ANSWER,
        { id: "gone", type: "unknown" },
      ];
    },
  };
});

// The proposal floor itself is proven on real SQL in
// `services/status/__tests__/status-of-narrowed-proposals.pglite.test.ts`.
vi.mock(
  "../../../services/status/status-of-narrowed-proposals.js",
  async () => ({
    readableWorkProposalIds: async () => h.readable,
  })
);

import { registerOrientRoutes } from "./orient.js";
import type { HubHono, HubVariables } from "./_shared.js";

const ID = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerOrientRoutes(a);
  return a;
}
const grant = (...scopes: Array<Record<string, unknown>>) =>
  ({ scopes, clientId: null }) as never;
const send = (path: string, g?: never) =>
  g ? runWithGrant(g, () => app().request(path)) : app().request(path);
const includeOf = (i: number) =>
  (h.calls[i]![2] as { include: string[] }).include;

describe("Hub REST GET /status-of: a key narrowed by its grant", () => {
  beforeEach(() => {
    h.calls = [];
    h.readable = new Set();
    h.work = undefined;
  });

  it("a pinned app is answered moves, history and work, the rest named withheld", async () => {
    const res = await send(
      `/status-of?ids=${ID}&include=work,history,signals`,
      grant({
        permissions: ["entity.read", "session.read"],
        workspaceIds: ["w1"],
      })
    );
    expect(res.status).toBe(200);
    expect(includeOf(0)).toEqual(["work", "history"]);
    const body = (await res.json()) as {
      statusOf: Array<Record<string, unknown>>;
      withheld: { parts: string[]; work?: { fields: string[] } };
    };
    expect(body.withheld.parts).toEqual(["signals"]);
    expect(body.withheld.work?.fields).toContain("proposals");
    expect(body.statusOf[0]).toEqual({
      id: "e1",
      type: "entity",
      name: "A piece",
      status: "draft",
      history: { events: [], truncated: false },
      work: { items: [], truncated: false },
      link: "l",
    });
    // The wait episode's foreign ref never reaches a narrowed key.
    expect(JSON.stringify(body)).not.toContain("foreign-id");
    // An id the key cannot read is as unknown as one that does not exist.
    expect(body.statusOf[1]).toEqual({ id: "gone", type: "unknown" });
  });

  const WORK = {
    items: [
      {
        sessionId: "s1",
        name: "Run",
        kind: "work",
        status: "active",
        label: "Active",
        category: "active",
        tone: "active",
        on: "subject",
        playbookId: "pb1",
        roomId: "room1",
        run: null,
        stages: {
          status: "ok",
          current: "draft",
          items: [
            {
              key: "draft",
              name: "Draft",
              position: "current",
              entry: {
                status: "running",
                attempt: 1,
                startedAt: "t",
                endedAt: null,
                agentName: "Scribe",
              },
            },
          ],
        },
        gates: {
          status: "ok",
          items: [
            {
              stageKey: "draft",
              stageName: "Draft",
              kind: "human",
              state: "pending",
              proposalId: "own-proposal",
              decidedByHuman: false,
              summary: "Approve stage: Draft",
              fromStage: "foreign-stage",
              canReview: true,
            },
          ],
        },
        asks: { status: "ok", total: 0, items: [] },
        proposals: {
          status: "ok",
          total: 1,
          items: [{ id: "foreign-proposal", title: "Foreign title" }],
        },
        holder: {
          kind: "agent",
          waitKind: null,
          since: null,
          agentName: "Scribe",
        },
        live: { status: "ok", state: "working", lastActivityAt: null },
        nextMove: {
          label: "Foreign next move",
          proposalId: "foreign-proposal",
        },
        lastCompletion: { summary: "Foreign summary" },
        stopped: null,
        link: "l",
      },
    ],
    truncated: false,
  };
  const PINNED_NO_AGENTS = grant({
    permissions: ["entity.read", "session.read"],
    workspaceIds: ["w1"],
  });
  const workOf = async (g: never) => {
    const res = await send(`/status-of?ids=${ID}&include=work`, g);
    const body = (await res.json()) as {
      statusOf: Array<{ work: { items: Array<Record<string, unknown>> } }>;
    };
    return { body, wire: JSON.stringify(body) };
  };

  it("work: foreign refs never reach a pinned key; an unreadable gate proposal reads withheld", async () => {
    h.work = WORK;
    const { body, wire } = await workOf(PINNED_NO_AGENTS);
    for (const leak of [
      "foreign-proposal",
      "own-proposal",
      "Foreign",
      "foreign-stage",
      "Scribe",
      "Approve stage",
    ])
      expect(wire).not.toContain(leak);
    const item = body.statusOf[0]!.work.items[0]!;
    expect(item).not.toHaveProperty("nextMove");
    expect(item).not.toHaveProperty("lastCompletion");
    expect(item.proposals).toMatchObject({ status: "withheld" });
    expect(
      (item.gates as { items: Array<Record<string, unknown>> }).items[0]
    ).toMatchObject({ stageKey: "draft", state: "withheld", canReview: false });
  });

  it("work: a gate proposal the floor reads is kept, its stage named from the declared stages", async () => {
    h.work = WORK;
    h.readable = new Set(["own-proposal"]);
    const { body, wire } = await workOf(PINNED_NO_AGENTS);
    const gate = (
      body.statusOf[0]!.work.items[0]!.gates as {
        items: Array<Record<string, unknown>>;
      }
    ).items[0]!;
    expect(gate).toMatchObject({
      state: "pending",
      proposalId: "own-proposal",
      summary: "Approve stage: Draft",
      canReview: true,
    });
    // A stage the session does not declare is never named.
    expect(gate).not.toHaveProperty("fromStage");
    expect(wire).not.toContain("foreign-stage");
    expect(wire).not.toContain("foreign-proposal");
  });

  it("work: an agent's name rides only with agent.read", async () => {
    h.work = WORK;
    const { wire } = await workOf(
      grant({
        permissions: ["entity.read", "session.read", "agent.read"],
        workspaceIds: ["w1"],
      })
    );
    expect(wire).toContain("Scribe");
  });

  it("CONTROL: a person and a key reading every subject get the whole answer", async () => {
    await send(`/status-of?ids=${ID}&include=work,history`);
    const res = await send(
      `/status-of?ids=${ID}&include=work`,
      grant({ permissions: ["*"] })
    );
    expect(includeOf(0)).toEqual(["work", "history"]);
    expect(includeOf(1)).toEqual(["work"]);
    const body = (await res.json()) as {
      statusOf: Array<Record<string, unknown>>;
      withheld?: unknown;
    };
    expect(body.withheld).toBeUndefined();
    expect(body.statusOf[0]).toHaveProperty("waitingOn");
  });

  it("no ids, or an unknown include, is a 400 and nothing is read", async () => {
    expect((await send(`/status-of`)).status).toBe(400);
    expect((await send(`/status-of?ids=${ID}&include=nope`)).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});
