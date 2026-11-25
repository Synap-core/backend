/**
 * Hub `POST /focus-sessions/:id/outputs/block` and `/outputs/delegate` — the
 * GRANT rung. Before it, both doors checked only the write scope and
 * workspace membership, so a key narrowed by a grant (a pod app's token, a
 * read-only key) could hand a session's slot to the person or start an agent
 * turn in the session's room in any space its person belongs to. Only
 * `/outputs/unblock` ran the rung (`answerGrantWrite` → `grantWriteDenial`:
 * `session.update` on the session's own space and project).
 *
 * Rows rule out, per door, driven through the REAL routes:
 *  - a key without `session.update` reaching the service (was 200);
 *  - a key with `session.update` pinned to space A reaching a session of
 *    space B (was 200: membership was the only floor);
 * and keep working (controls): the same pinned key on a session of its own
 * space, an agent key holding the AI preset (the agent's own key), a person's
 * full-access key, and a request with no grant at all (the signed-in person;
 * the browser calls the tRPC twins, which no key reaches).
 *
 * Stubbed: the services behind the doors (a probe records that the step after
 * the floors was reached), the session row, the session's place, membership.
 * Cannot see: production SQL (`answerGrantWrite`'s place read is a stub here).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, runWithGrant, type KeyGrant } from "@synap/database";
import { focusSessions } from "@synap/database/schema";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";
import type { HubHono, HubVariables } from "./_shared.js";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MY_AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WS_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const WS_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ID = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({ reached: [] as string[] }));

vi.mock("@synap/database", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getWorkspaceMembership: async () => ({ role: "member" }),
}));
vi.mock("../../../services/focus-sessions/delegate-output.js", () => ({
  delegateExpectedOutput: async () => {
    h.reached.push("delegate");
    return { status: "not_found" };
  },
}));
vi.mock("../../../services/focus-sessions/block-output.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  blockExpectedOutput: async () => {
    h.reached.push("block");
    return { status: "not_found" };
  },
  unblockExpectedOutput: async () => {
    h.reached.push("unblock");
    return { status: "not_found" };
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");
const { BLOCKED_REASONS } = await import("@synap/playbooks");

const AI_PERMISSIONS = GRANT_PRESETS.find(
  (r) => r.id === AI_READ_PROPOSE_ROLE_ID
)!.grant.permissions;

const grant = (
  permissions: readonly string[],
  workspaceIds?: string[]
): KeyGrant => ({
  scopes: [
    {
      permissions: [...permissions],
      ...(workspaceIds ? { workspaceIds } : {}),
    },
  ],
  clientId: null,
});

/** The session (owned by ME) in `workspaceId`, and its place for the rung. */
function serveSession(workspaceId: string) {
  const spies = [
    vi.spyOn(db.query.focusSessions, "findFirst").mockResolvedValue({
      id: ID,
      userId: ME,
      workspaceId,
      projectId: null,
      goal: "g",
      status: "active",
      criteria: [],
      expectedOutputs: [],
      metadata: {},
    } as never),
    // `answerGrantWrite`'s read of the session's space and project.
    vi.spyOn(db, "select").mockImplementation((() => {
      let table: unknown;
      const chain = {
        from: (t: unknown) => {
          table = t;
          return chain;
        },
        where: () => chain,
        limit: async () =>
          table === focusSessions ? [{ workspaceId, projectId: null }] : [],
      };
      return chain;
    }) as never),
  ];
  return () => spies.forEach((s) => s.mockRestore());
}

function app(vars: Record<string, unknown>, g: KeyGrant | null): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", ME);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
    return g ? runWithGrant(g, () => next()) : next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const DOORS = [
  {
    door: "block",
    body: { expectedLabel: "Draft", blockedReason: BLOCKED_REASONS[0] },
  },
  { door: "delegate", body: { expectedLabel: "Draft" } },
] as const;

const send = (
  door: string,
  body: unknown,
  g: KeyGrant | null,
  vars: Record<string, unknown> = { apiKeyId: "k", keyType: "hub_inbound" }
) =>
  app(vars, g).request(`/focus-sessions/${ID}/outputs/${door}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

let restore: () => void = () => {};
beforeEach(() => {
  h.reached = [];
});
afterEach(() => restore());

describe.each(DOORS)(
  "POST /focus-sessions/:id/outputs/$door — the grant rung",
  ({ door, body }) => {
    it("a key without session.update is refused before the service runs", async () => {
      restore = serveSession(WS_A);
      for (const g of [
        grant(["session.read"]),
        grant(["session.read", "entity.read"], [WS_A]),
      ]) {
        const res = await send(door, body, g);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toContain(
          "session.update"
        );
      }
      expect(h.reached).toEqual([]);
    });

    it("a key holding session.update in space A cannot act on a session of space B", async () => {
      restore = serveSession(WS_B);
      const res = await send(door, body, grant(["session.update"], [WS_A]));
      expect(res.status).toBe(403);
      expect(h.reached).toEqual([]);
    });

    it("CONTROL: the same key on a session of its own space reaches the service", async () => {
      restore = serveSession(WS_A);
      const res = await send(door, body, grant(["session.update"], [WS_A]));
      expect(res.status).toBe(404); // the stubbed service's own `not_found`
      expect(h.reached).toEqual([door]);
    });

    it("CONTROL: the agent's own key (AI preset), a full key and no grant keep working", async () => {
      restore = serveSession(WS_A);
      const agent = {
        apiKeyId: "k",
        keyType: "hub_inbound",
        agentUserId: MY_AGENT,
      };
      await send(door, body, grant(AI_PERMISSIONS), agent);
      await send(door, body, grant(AI_PERMISSIONS, [WS_A]), agent);
      await send(door, body, grant(["*"]));
      await send(door, body, null);
      expect(h.reached).toEqual([door, door, door, door]);
    });
  }
);

describe("POST /focus-sessions/:id/outputs/unblock — the rung it already ran (control)", () => {
  it("refused without session.update, reached with it", async () => {
    restore = serveSession(WS_A);
    const body = { expectedLabel: "Draft" };
    expect((await send("unblock", body, grant(["session.read"]))).status).toBe(
      403
    );
    expect(h.reached).toEqual([]);
    await send("unblock", body, grant(["session.update"], [WS_A]));
    expect(h.reached).toEqual(["unblock"]);
  });
});
