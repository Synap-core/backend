/**
 * An approved `messaging.external.send` sends AS the provider account — the
 * connector's `externalAccountId` (`messaging_accounts.external_id`, e.g. the
 * Unipile `account_id`) — never the pod's own row id.
 *
 * The defect: the executor resolved the approver's account for the platform
 * and passed `msgAccount.id` (the `messaging_accounts` primary key, a pod
 * uuid) as `accountId`. Every connector's `sendMessage(externalAccountId, …)`
 * hands that straight to the provider (`UnipileConnector`: `account_id`), so
 * an approved LinkedIn / WhatsApp / mail send went out under an id the
 * provider does not know. The REST send door already floors on and passes
 * `externalId` (8430c6477).
 *
 * Two halves, each tried on its own:
 *  - the real executor passes the resolved account's `externalId`;
 *  - the real resolver reads `externalId` — driven against a fake that returns
 *    ONLY the columns asked for, as drizzle's `columns` selection does.
 * The connector, at-most-once claim and db writes are stubbed.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  sendArgs: [] as Array<Record<string, unknown>>,
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
}));
vi.mock("../../../connectors/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../connectors/index.js")>()),
  // A per-account connector (Unipile / Stalwart).
  getMessagingConnector: async () => ({ requiresAccount: () => true }),
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
const { resolveMessagingAccountForPlatform } =
  await import("../apply-approval.js");
registerMessagingExecutors();

const ROW_ID = "8f0c2a4e-0000-4000-8000-00000000a001"; // messaging_accounts.id
const PROVIDER_ACCOUNT = "unipile-acct-Xy12"; // messaging_accounts.external_id

const ACCOUNT_ROW = {
  id: ROW_ID,
  userId: "owner-1",
  provider: "linkedin",
  externalId: PROVIDER_ACCOUNT,
};

describe("messaging.external.send approve executor", () => {
  it("sends as the provider account (externalId), not the pod row id", async () => {
    const exec = proposalExecRegistry.resolveExact("messaging.external.send")!;
    expect(exec).toBeDefined();
    const data = { threadId: "t-1", body: "hi", platform: "linkedin" };
    await exec.execute({
      proposal: { id: "p-1", workspaceId: null, sessionId: null, data },
      payload: data,
      userId: "owner-1",
      input: { proposalId: "p-1" },
      deps: {
        emitProposalReviewed: () => undefined,
        resolveMessagingAccountForPlatform: async () => ({
          id: ROW_ID,
          externalId: PROVIDER_ACCOUNT,
        }),
      },
    } as never);
    expect(h.sendArgs).toHaveLength(1);
    expect(h.sendArgs[0]!.accountId).toBe(PROVIDER_ACCOUNT);
    expect(h.sendArgs[0]!.accountId).not.toBe(ROW_ID);
  });
});

describe("resolveMessagingAccountForPlatform", () => {
  /** A findFirst that returns only the selected columns of the one row. */
  function fakeDb() {
    return {
      query: {
        messagingAccounts: {
          findFirst: async (q: { columns?: Record<string, boolean> }) => {
            const cols = Object.keys(q.columns ?? {}).filter(
              (k) => q.columns![k]
            );
            return cols.length === 0
              ? ACCOUNT_ROW
              : Object.fromEntries(
                  cols.map((k) => [k, (ACCOUNT_ROW as never)[k]])
                );
          },
        },
      },
    } as never;
  }

  it("returns the provider account id the connector sends with", async () => {
    const acct = await resolveMessagingAccountForPlatform(
      fakeDb(),
      "owner-1",
      "linkedin"
    );
    expect(acct).toMatchObject({ externalId: PROVIDER_ACCOUNT });
  });
});
