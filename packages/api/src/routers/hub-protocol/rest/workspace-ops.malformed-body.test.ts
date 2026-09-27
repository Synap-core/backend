/**
 * A MALFORMED body on a governed workspace-op route is a 400 — never the empty
 * default. The defect (RV1 S1): `readJson` swallowed a parse failure into `{}`,
 * so a truncated `{"restore":true` on `POST /workspaces/:id/archive` read as
 * "no restore flag" and ARCHIVED the space instead of restoring it.
 *
 * Drives the real route with the real `readJsonBody`; replaced: the door
 * (records what reached it) and the acting-user DB lookup.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  archiveCalls: [] as Array<Record<string, unknown>>,
  renameCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../services/workspace-ops-doors.js", () => ({
  archiveWorkspaceDoor: vi.fn(
    async (_a: unknown, input: Record<string, unknown>) => {
      h.archiveCalls.push(input);
      return { status: "applied", workspaceId: input.workspaceId };
    }
  ),
  renameWorkspaceDoor: vi.fn(
    async (_a: unknown, input: Record<string, unknown>) => {
      h.renameCalls.push(input);
      return { status: "applied" };
    }
  ),
  moveEntitiesDoor: vi.fn(),
  grantProfileAccessDoor: vi.fn(),
}));

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveActingContext: vi.fn(async () => ({ ok: true, userId: USER })),
  };
});

const { registerWorkspaceOpsRoutes } = await import("./workspace-ops.js");

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";

function app() {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("userId" as never, USER as never);
    await next();
  });
  registerWorkspaceOpsRoutes(a as never);
  return a;
}

function post(path: string, body: string, method = "POST") {
  return app().request(path, {
    method,
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("workspace-ops: malformed JSON is a 400, empty body is {}", () => {
  beforeEach(() => {
    h.archiveCalls.length = 0;
    h.renameCalls.length = 0;
  });

  it("a truncated restore body does NOT archive", async () => {
    const res = await post(`/workspaces/${WS}/archive`, '{"restore":true');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(h.archiveCalls).toEqual([]);
  });

  it("a truncated rename body does not rename", async () => {
    const res = await post(`/workspaces/${WS}`, '{"name":"X', "PATCH");
    expect(res.status).toBe(400);
    expect(h.renameCalls).toEqual([]);
  });

  it("an EMPTY body is still the optional-body default (archive, no restore)", async () => {
    const res = await post(`/workspaces/${WS}/archive`, "");
    expect(res.status).toBe(200);
    expect(h.archiveCalls).toEqual([
      { workspaceId: WS, restore: false, reasoning: undefined },
    ]);
  });

  it("a well-formed restore body restores", async () => {
    const res = await post(`/workspaces/${WS}/archive`, '{"restore":true}');
    expect(res.status).toBe(200);
    expect(h.archiveCalls[0]).toMatchObject({ restore: true });
  });
});
