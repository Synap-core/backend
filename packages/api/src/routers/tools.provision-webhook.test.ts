/**
 * `tools.provisionWebhook` — minting or rotating a tool's inbound webhook token
 * is governed (CP ticket 7c01a8b7). An AGENT caller proposes and no token is
 * minted (the mint service is never reached); a person's call mints through
 * the service, which carries the write gate and the audit row.
 *
 * The governance gate and the mint service are stubbed; what is under test is
 * that the door CONSULTS the gate, honours its verdict, and refuses a row that
 * takes no webhook BEFORE filing a proposal for it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { INBOUND_WEBHOOK_PROVIDERS } from "../services/webhooks/inbound-webhook-providers.js";

const h = vi.hoisted(() => ({
  verdict: {} as Record<string, unknown>,
  gated: [] as Array<Record<string, unknown>>,
  minted: [] as Array<Record<string, unknown>>,
  toolName: "",
}));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (args: Record<string, unknown>) => {
    h.gated.push(args);
    return h.verdict;
  },
}));
vi.mock("../services/webhooks/provision-inbound-webhook.js", () => ({
  provisionInboundWebhook: async (a: Record<string, unknown>) => {
    h.minted.push(a);
    return {
      provider: "postiz",
      url: "https://pod.test/api/webhooks/postiz/tok",
      rotated: a.rotate === true,
      missingConfig: [],
      setupStep: null,
    };
  },
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    query: {
      tools: {
        findFirst: async () => ({
          id: "00000000-0000-4000-8000-000000000001",
          name: h.toolName,
          workspaceId: "ws-1",
          metadata: {},
        }),
      },
    },
  },
}));

import { toolsRouter } from "./tools.js";

const ID = "00000000-0000-4000-8000-000000000001";
const caller = () =>
  toolsRouter.createCaller({
    authenticated: true,
    userId: "owner-1",
    agentUserId: "agent-1",
  } as never);

beforeEach(() => {
  h.gated.length = 0;
  h.minted.length = 0;
  h.toolName = Object.values(INBOUND_WEBHOOK_PROVIDERS)[0].toolName;
});

describe("tools.provisionWebhook is governed", () => {
  it("an agent caller gets `proposed` and no token is minted (mint and rotate)", async () => {
    h.verdict = { proposalId: "proposal-1" };
    for (const rotate of [false, true]) {
      const res = await caller().provisionWebhook({ id: ID, rotate });
      expect(res).toMatchObject({
        status: "proposed",
        proposalId: "proposal-1",
      });
    }
    expect(h.gated).toHaveLength(2);
    expect(h.gated[1]).toMatchObject({
      subjectType: "tool",
      action: "provisionWebhook",
      data: { id: ID, rotate: true },
    });
    expect(h.minted).toHaveLength(0);
  });

  it("a denied caller is refused and no token is minted", async () => {
    h.verdict = { denied: true, reason: "no" };
    await expect(caller().provisionWebhook({ id: ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(h.minted).toHaveLength(0);
  });

  it("a person is granted: the mint service runs and the URL comes back", async () => {
    h.verdict = { granted: true };
    const res = await caller().provisionWebhook({ id: ID, rotate: true });
    expect(res).toMatchObject({
      status: "provisioned",
      url: "https://pod.test/api/webhooks/postiz/tok",
      rotated: true,
    });
    expect(h.minted).toEqual([{ userId: "owner-1", toolId: ID, rotate: true }]);
  });

  it("a tool that takes no webhook is refused before any proposal is filed", async () => {
    h.toolName = "not-a-webhook-tool";
    h.verdict = { proposalId: "proposal-1" };
    await expect(caller().provisionWebhook({ id: ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.gated).toHaveLength(0);
  });
});

describe("one door", () => {
  it("the Hub REST route replays the procedure and mints nothing itself", () => {
    const src = readFileSync(
      join(process.cwd(), "src/routers/hub-protocol/rest/tools.ts"),
      "utf8"
    );
    const start = src.indexOf('app.post("/tools/:id/webhook"');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("app.", start + 10);
    const body = src.slice(start, end);
    expect(body).toContain("caller.provisionWebhook(");
    expect(body).not.toContain("provisionInboundWebhook(");
  });
});
