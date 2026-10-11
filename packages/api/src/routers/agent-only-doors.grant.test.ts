/**
 * "Only the person can …" doors refuse an AGENT key — and a key that is not an
 * agent used to pass without its grant being read at all (the grant is only
 * enforced inside `checkPermissionOrPropose`, which these doors never call).
 * Proven here through the real router, the real grant check and the real
 * request-grant scope: a narrow human key is refused outside its grant, a
 * Full access (`*`) key and a signed-in session still pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  cancelCalls: [] as Array<Record<string, unknown>>,
  giveCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../services/agent-dispatch/cancel-run.js", () => ({
  cancelRun: async (input: Record<string, unknown>) => {
    h.cancelCalls.push(input);
    return { status: "cancelled" };
  },
}));
vi.mock("../services/captures/give-to-agent.js", () => ({
  giveCaptureToAgent: async (input: Record<string, unknown>) => {
    h.giveCalls.push(input);
    return { status: "given" };
  },
}));

import { runWithGrant, type KeyGrant } from "@synap/database";
import { playbookRunsRouter } from "./playbook-runs.js";
import { capturesRouter } from "./captures.js";
import { agentUsersRouter } from "./agent-users.js";
import type { Context } from "../types/context.js";

const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CAPTURE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ctx = {
  authenticated: true,
  userId: "user-1",
  workspaceId: null,
} as unknown as Context;

function grantOf(permissions: string[]): KeyGrant {
  return {
    scopes: [
      { permissions, workspaceIds: null, projectIds: null, entityIds: null },
    ],
    clientId: null,
  } as KeyGrant;
}

const cancel = () =>
  playbookRunsRouter.createCaller(ctx).cancelRun({ runId: RUN });
const give = () =>
  capturesRouter.createCaller(ctx).giveToAgent({ captureId: CAPTURE });

beforeEach(() => {
  h.cancelCalls.length = 0;
  h.giveCalls.length = 0;
});

describe("a human key is bounded by its grant on agent-only doors", () => {
  it("playbookRuns.cancelRun: a key granted only entities is refused — nothing cancelled", async () => {
    await expect(
      runWithGrant(grantOf(["entity"]), cancel)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.cancelCalls).toHaveLength(0);
  });

  it("captures.giveToAgent: a key granted only entities is refused — nothing handed over", async () => {
    await expect(runWithGrant(grantOf(["entity"]), give)).rejects.toMatchObject(
      { code: "FORBIDDEN" }
    );
    expect(h.giveCalls).toHaveLength(0);
  });

  it("a Full access (`*`) key passes both", async () => {
    await runWithGrant(grantOf(["*"]), cancel);
    await runWithGrant(grantOf(["*"]), give);
    expect(h.cancelCalls).toHaveLength(1);
    expect(h.giveCalls).toHaveLength(1);
  });

  it("a signed-in session (no grant) is unchanged", async () => {
    await cancel();
    await give();
    expect(h.cancelCalls).toHaveLength(1);
    expect(h.giveCalls).toHaveLength(1);
  });
});

describe("agentUsers.disconnect / setBinding read the key's grant", () => {
  const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const agents = () => agentUsersRouter.createCaller(ctx);

  it("disconnect (revokes keys) needs api_key.delete", async () => {
    await expect(
      runWithGrant(grantOf(["entity", "agent.read"]), () =>
        agents().disconnect({ agentUserId: AGENT })
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("api_key.delete"),
    });
  });

  it("setBinding (re-points dispatch) needs agent.update", async () => {
    await expect(
      runWithGrant(grantOf(["entity", "link.create"]), () =>
        agents().setBinding({ agentUserId: AGENT, toolId: null })
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("agent.update"),
    });
  });
});
