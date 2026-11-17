/**
 * Hub REST `GET /timeline` for a key NARROWED by its grant (a pod app, founder
 * decision D1, 17 Nov 2026): the route asks `timelineReach` and
 *  - reads a SESSION's timeline with the sources the grant does not reach
 *    named as withheld (dev facts always; decisions without an unpinned
 *    `proposal.read`);
 *  - refuses a goal's or a PR's (403), never answering them partly;
 *  - leaves a person, and a key reading every subject, whole.
 *
 * DB-free: `readTimeline` is stubbed to record what it was asked; the reader
 * itself skips the sources in `read-timeline.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { runWithGrant } from "@synap/database";

const h = vi.hoisted(() => ({ actors: [] as unknown[] }));

vi.mock("../../../services/timeline/read-timeline.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    readTimeline: async (subject: { kind: string }, actor: unknown) => {
      h.actors.push(actor);
      return { subject, events: [], truncated: false };
    },
  };
});

import { registerTimelineRoutes } from "./timeline.js";
import type { HubHono, HubVariables } from "./_shared.js";

const SESSION = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const GOAL = "4f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerTimelineRoutes(a);
  return a;
}
const grant = (...scopes: Array<Record<string, unknown>>) =>
  ({ scopes, clientId: null }) as never;
const send = (path: string, g?: never) =>
  g ? runWithGrant(g, () => app().request(path)) : app().request(path);
const withholdOf = (i: number) =>
  (h.actors[i] as { withhold?: string[] }).withhold;

describe("Hub REST GET /timeline — a key narrowed by its grant", () => {
  beforeEach(() => {
    h.actors = [];
  });

  it("a pod app reads a session's timeline, every source past its grant withheld", async () => {
    const res = await send(
      `/timeline?sessionId=${SESSION}`,
      grant({ permissions: ["session.read"], workspaceIds: ["w1"] })
    );
    expect(res.status).toBe(200);
    expect(withholdOf(0)).toEqual([
      "dev_facts",
      "decisions",
      "runners",
      "room_posts",
    ]);
  });

  it("unpinned proposal and channel reads and agent.read bring their sources back, never the dev facts", async () => {
    const res = await send(
      `/timeline?sessionId=${SESSION}`,
      grant({
        permissions: [
          "session.read",
          "proposal.read",
          "channel.read",
          "agent.read",
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(withholdOf(0)).toEqual(["dev_facts"]);
  });

  it("a goal's or a PR's timeline is a 403 for it, and nothing is read", async () => {
    const g = grant({ permissions: ["session.read", "proposal.read"] });
    for (const path of [
      `/timeline?goalId=${GOAL}`,
      `/timeline?pr=Synap-core/backend%2312`,
    ]) {
      const res = await send(path, g);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "GRANT_DOOR_UNSUPPORTED",
      });
    }
    expect(h.actors).toEqual([]);
  });

  it("CONTROL: a person and a key reading every subject read it whole", async () => {
    await send(`/timeline?goalId=${GOAL}`);
    await send(
      `/timeline?sessionId=${SESSION}`,
      grant({
        permissions: [
          "track.read",
          "session.read",
          "event.read",
          "proposal.read",
        ],
      })
    );
    expect(h.actors).toHaveLength(2);
    expect(withholdOf(0)).toBeUndefined();
    expect(withholdOf(1)).toBeUndefined();
  });
});
