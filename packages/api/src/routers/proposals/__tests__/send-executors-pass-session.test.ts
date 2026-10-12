/**
 * An approved irreversible send is replayed WITH the session it was asked in
 * (FB2 item 3). The send door's worker ceiling keys on that session; a replay
 * that drops it is never re-checked and its send is never counted.
 *
 * Real `messaging.external.send` / `provider.action` executors; the send
 * doors, the at-most-once claim and the db are stubbed. Negative control:
 * delete the `sessionId: proposal.sessionId` line in either executor and its
 * row goes red.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  sendArgs: [] as Array<Record<string, unknown>>,
  providerArgs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock("../../../connectors/external-dispatch.js", () => ({
  sendExternalMessage: async (args: Record<string, unknown>) => {
    h.sendArgs.push(args);
    return { success: true };
  },
  triggerProviderAction: async (args: Record<string, unknown>) => {
    h.providerArgs.push(args);
    return { success: true, status: 200, body: {} };
  },
}));
vi.mock("../../../connectors/index.js", () => ({
  getMessagingConnector: async () => ({ requiresAccount: () => false }),
}));
vi.mock("../../../services/capabilities/execute-capability.js", () => ({
  assertApprovalTargetResolves: async () => null,
}));
vi.mock("../executors/shared.js", () => ({
  reportApproved: () => undefined,
  dispatchExternalOnce: async (_id: string, send: () => Promise<unknown>) => {
    await send();
  },
}));

const { proposalExecRegistry } = await import("../execution-registry.js");
const { registerMessagingExecutors } =
  await import("../executors/messaging.js");
const { registerProviderExecutors } = await import("../executors/provider.js");
registerMessagingExecutors();
registerProviderExecutors();

const SESSION = "22222222-2222-4222-8222-222222222222";
const deps = { emitProposalReviewed: () => undefined } as never;

function run(key: string, data: Record<string, unknown>) {
  const exec = proposalExecRegistry.resolveExact(key)!;
  expect(exec).toBeDefined();
  return exec.execute({
    proposal: {
      id: "p-1",
      workspaceId: null,
      sessionId: SESSION,
      data,
    } as never,
    payload: data as never,
    userId: "owner-1",
    input: { proposalId: "p-1" },
    deps,
  } as never);
}

describe("send executors replay with the proposal's session", () => {
  it("messaging.external.send", async () => {
    await run("messaging.external.send", {
      threadId: "t-1",
      body: "hi",
      platform: "discord",
    });
    expect(h.sendArgs[0]).toMatchObject({
      alreadyApproved: true,
      sessionId: SESSION,
    });
  });

  it("provider.action", async () => {
    await run("provider.action", {
      provider: "nango://gmail",
      method: "POST",
      path: "/send",
    });
    expect(h.providerArgs[0]).toMatchObject({
      alreadyApproved: true,
      sessionId: SESSION,
    });
  });
});
