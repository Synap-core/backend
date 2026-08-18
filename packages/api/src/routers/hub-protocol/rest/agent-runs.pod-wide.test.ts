/**
 * Contract tests for POST /api/hub/agent-runs — POD-WIDE (workspaceId null).
 *
 * Why this exists: the personal/Companion channel is `scope: 'pod'` with
 * `workspaceId: null` BY DESIGN, but the body schema was `z.string()`, so the
 * telemetry the IS wants to send for nearly every Companion turn 400'd at the
 * door. 206 completed agent turns had produced ZERO agent-run rows. These tests
 * pin the two halves of the fix so it cannot silently regress:
 *
 *   1. a null / omitted workspaceId is ACCEPTED (200), and
 *   2. a FAILED pod-wide run notifies the run's OWNER via the pod-wide
 *      notification path — NOT `createForWorkspace`, which would look up
 *      `workspaceMembers` for a null workspace and notify nobody.
 *
 * No database: the event store, the cooldown probe and NotificationService are
 * stubbed. What is under test is what the DOOR accepts and what it BUILDS.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "user-1";

const appended: any[] = [];

// PARTIAL mock via importOriginal — a whole-module factory nulls every sibling
// export and this graph pulls in far more of @synap/database than we stub.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    eventRepository: {
      append: async (e: any) => {
        appended.push(e);
        return { id: `row-${appended.length}` };
      },
    },
    // Cooldown probe: `db.select().from().where().limit()` → no recent row, so
    // the notification is never suppressed by the storm guard.
    db: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
    },
  };
});

const createForWorkspace = vi.fn(async (_input: any) => ["notif-ws"]);
const create = vi.fn(async (_input: any) => "notif-pod");
vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: { createForWorkspace, create },
}));

const { registerEventsRoutes } = await import("./events.js");

function buildApp() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set(
      "scopes" as never,
      ["hub-protocol.read", "hub-protocol.write"] as never
    );
    c.set("userId" as never, USER as never);
    await next();
  });
  registerEventsRoutes(app as never);
  return app;
}

const app = buildApp();

function post(body: unknown) {
  return app.request("/agent-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseRun = {
  agentUserId: "agent-1",
  agentType: "meta",
  latencyMs: 1234,
  toolCount: 2,
  runStatus: "succeeded" as const,
  costUsd: 0.0163,
};

beforeEach(() => {
  appended.length = 0;
  createForWorkspace.mockClear();
  create.mockClear();
});

describe("POST /agent-runs — pod-wide workspaceId", () => {
  it("accepts workspaceId: null (the Companion channel's own shape)", async () => {
    const res = await post({ ...baseRun, workspaceId: null });
    expect(res.status).toBe(200);
    expect(appended).toHaveLength(1);
    expect(appended[0].data.workspaceId).toBeNull();
    // The telemetry must survive the null workspace, not be dropped with it.
    expect(appended[0].costUsd).toBe(0.0163);
  });

  it("accepts an omitted workspaceId", async () => {
    const res = await post(baseRun);
    expect(res.status).toBe(200);
    expect(appended).toHaveLength(1);
  });

  it("still accepts a workspace-scoped run", async () => {
    const res = await post({ ...baseRun, workspaceId: WS });
    expect(res.status).toBe(200);
    expect(appended[0].data.workspaceId).toBe(WS);
  });
});

describe("POST /agent-runs — failed-run notification routing", () => {
  it("a failed POD-WIDE run notifies the OWNER, never createForWorkspace", async () => {
    const res = await post({
      ...baseRun,
      workspaceId: null,
      runStatus: "failed",
      errorMessage: "boom",
    });
    expect(res.status).toBe(200);
    // createForWorkspace on a null workspace would query workspaceMembers for
    // "null", find nobody, and silently notify no one.
    expect(createForWorkspace).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0][0] as any;
    expect(arg.workspaceId).toBeNull();
    expect(arg.userId).toBe(USER);
    // Collapse scope is the RECIPIENT — keying on `pod:` alone would let one
    // user's cooldown suppress another user's alert for the same agent id.
    expect(arg.groupKey).toBe(`pod:${USER}:agent.task_failed:agent-1`);
  });

  it("a failed WORKSPACE run still fans out to members", async () => {
    const res = await post({
      ...baseRun,
      workspaceId: WS,
      runStatus: "failed",
      errorMessage: "boom",
    });
    expect(res.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
    expect(createForWorkspace).toHaveBeenCalledTimes(1);
    const arg = createForWorkspace.mock.calls[0][0] as any;
    expect(arg.workspaceId).toBe(WS);
    expect(arg.groupKey).toBe(`${WS}:agent.task_failed:agent-1`);
  });

  it("a SUCCEEDED pod-wide run notifies nobody", async () => {
    await post({ ...baseRun, workspaceId: null });
    expect(create).not.toHaveBeenCalled();
    expect(createForWorkspace).not.toHaveBeenCalled();
  });
});
