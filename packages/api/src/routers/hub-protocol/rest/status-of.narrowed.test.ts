/**
 * Hub REST `GET /status-of` for a key NARROWED by its grant (a pod app pinned
 * to spaces): the route asks `statusOfReach` and
 *  - reads only the parts that touch the subject's own record (`moves`,
 *    `history`) and names the others as withheld;
 *  - cuts every answer back to the status (no waitingOn, nextMove, work...);
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

const h = vi.hoisted(() => ({ calls: [] as unknown[][] }));
const FULL_ANSWER = {
  id: "e1",
  type: "entity",
  name: "A piece",
  status: "draft",
  waitingOn: [{ kind: "person" }],
  nextMove: { kind: "x" },
  work: { items: [] },
  roles: [],
  history: { events: [], truncated: false },
  link: "l",
};

vi.mock("../../../services/status/status-read.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    readStatusOf: async (...args: unknown[]) => {
      h.calls.push(args);
      return [FULL_ANSWER, { id: "gone", type: "unknown" }];
    },
  };
});

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
  });

  it("a pinned app is answered moves and history only, the rest named withheld", async () => {
    const res = await send(
      `/status-of?ids=${ID}&include=work,history,signals`,
      grant({ permissions: ["entity.read", "session.read"], workspaceIds: ["w1"] })
    );
    expect(res.status).toBe(200);
    expect(includeOf(0)).toEqual(["history"]);
    const body = (await res.json()) as {
      statusOf: Array<Record<string, unknown>>;
      withheld: { parts: string[] };
    };
    expect(body.withheld.parts).toEqual(["work", "signals"]);
    expect(body.statusOf[0]).toEqual({
      id: "e1",
      type: "entity",
      name: "A piece",
      status: "draft",
      history: { events: [], truncated: false },
      link: "l",
    });
    // An id the key cannot read is as unknown as one that does not exist.
    expect(body.statusOf[1]).toEqual({ id: "gone", type: "unknown" });
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
