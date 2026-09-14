/**
 * Seam test — the two external-dispatch gate doors return the shared
 * not-enabled refusal instead of a dead end.
 *
 *   - `triggerProviderAction` (provider tools: /connectors/tool-execute, IS
 *     callProvider, code skills): agent → enable request + "Nothing ran";
 *     human → "Nothing ran" + Settings.
 *   - `sendExternalMessage` (agent messaging sends): used to return a bare
 *     `{ success: false }` with no reason at all.
 *
 * Real door code + real shared refusal; the tool read, the gate, the container
 * lens and the proposal insert are stubbed. Nothing is dispatched.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const TOOL_ROW = {
  id: "tool-send",
  name: "gmail_send",
  approved: false,
  createdBy: "owner-1",
  credentialRef: "nango://gmail",
  authBinding: "static",
  workspaceId: null,
};
let toolRows: unknown[] = [TOOL_ROW];
let seededMessaging: unknown[] = [];
const inserted: any[] = [];
const sendMessage = vi.fn(async () => undefined);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: {
        channels: {
          findFirst: async () => ({ id: "ch-1", externalSource: "unipile" }),
        },
      },
      select: (cols?: Record<string, unknown>) => ({
        from: (table: unknown) => ({
          where: () => {
            // gateMessagingSend selects {id, approved, createdBy} — no name.
            const isMessagingSeed =
              table === (actual as any).tools &&
              cols &&
              !("name" in cols) &&
              "createdBy" in cols;
            const rows =
              table === (actual as any).tools
                ? isMessagingSeed
                  ? seededMessaging
                  : cols
                    ? [{ id: "tool-send", name: "gmail_send" }]
                    : toolRows
                : [];
            return {
              limit: async () => rows,
              then: (resolve: (v: unknown) => unknown) => resolve(rows),
            };
          },
        }),
      }),
    },
  };
});

vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMessagingConnector: async () => ({ sendMessage }),
}));

vi.mock("../services/capabilities/gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({
    decision: "deny",
    reason: "This capability is installed but not yet enabled.",
  }),
}));

vi.mock("../services/capabilities/capability-registry.js", () => ({
  containerMemberKey: (kind: string, id: string) => `${kind}:${id}`,
  loadContainerRefs: async () => new Map(),
}));
vi.mock("../services/links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCapabilityMemberParts: async () => [],
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: any) => {
    inserted.push(input);
    return { id: `prop-${inserted.length}` };
  },
}));

const { triggerProviderAction, sendExternalMessage } =
  await import("./external-dispatch.js");

const CALL = {
  userId: "owner-1",
  provider: "nango://gmail",
  method: "POST",
  path: "/send",
  workspaceId: "ws-1",
};

describe("triggerProviderAction — not-enabled tool", () => {
  beforeEach(() => {
    inserted.length = 0;
    toolRows = [TOOL_ROW];
  });

  it("agent → one enable request for the tool, and the error says nothing ran", async () => {
    const out = await triggerProviderAction({
      ...CALL,
      agentUserId: "agent-1",
    });
    expect(out.success).toBe(false);
    expect(out.proposed).toBeFalsy();
    expect(out.error).toMatch(/^Nothing ran/);
    expect(out.enableProposal).toMatchObject({
      status: "proposed",
      originalActionRan: false,
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ proposalType: "capability.enable" });
    expect(inserted[0].data.toolIds).toEqual(["tool-send"]);
  });

  it("human → no request, Settings pointer", async () => {
    const out = await triggerProviderAction(CALL);
    expect(out.success).toBe(false);
    expect(out.error).toBe(
      'Nothing ran: "gmail_send" is installed but not enabled. Enable it in Settings → Capabilities, then run it again.'
    );
    expect(out.enableProposal).toBeUndefined();
    expect(inserted).toHaveLength(0);
  });
});

describe("sendExternalMessage — agent send on a not-enabled messaging capability", () => {
  const SEND = {
    threadId: "t-1",
    accountId: "",
    body: "hi",
    userId: "owner-1",
    agentUserId: "agent-1",
    workspaceId: "ws-1",
  };

  beforeEach(() => {
    inserted.length = 0;
    sendMessage.mockClear();
  });

  it("a SEEDED messaging tool → enable request, reason, nothing sent", async () => {
    seededMessaging = [{ id: "tool-msg", approved: false, createdBy: null }];
    const out = await sendExternalMessage(SEND);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/^Nothing ran/);
    expect(out.enableProposal?.status).toBe("proposed");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("NO messaging tool row → says there is nothing to enable, files nothing, nothing sent", async () => {
    seededMessaging = [];
    const out = await sendExternalMessage(SEND);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/has no installed capability/);
    expect(out.enableProposal).toBeUndefined();
    expect(inserted).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
