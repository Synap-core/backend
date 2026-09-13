/**
 * Hub REST — POST /vault/request files the proposal as the AUTHENTICATED
 * caller, never as a body-named user.
 *
 * THE DEFECT (found by hub-write-agent-attribution-fallback tripwire,
 * 2026-09-13): the handler set `userId = body.agentUserId ?? c.get("userId")`
 * with no check, so any hub-write key could file a `vault.request` proposal —
 * and raise the urgent `ai_request.vault_access` banner with caller-written
 * text — as ANOTHER user. Now the human comes from auth and the agent goes
 * through `resolveActorId` (only an agent the caller holds).
 *
 * DB-free door test: the REAL handler runs. `resolveActorId` is replaced by a
 * fake that mirrors the real rule (own id, or an agent linked to the caller);
 * the proposal writer and notifier are spied.
 *
 * NOT covered: `resolveActorId`'s own DB lookups, and the poll route.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const USER_ID = "e418d146-0000-4000-8000-000000000001";
const OWN_AGENT = "0e0403a8-0000-4000-8000-000000000002";
const FORGED = "99999999-0000-4000-8000-000000000009";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const createProposalMock = vi.fn();
const notifyMock = vi.fn();

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // The real rule, minus the DB: no agent → the human; the caller's linked
    // agent → that agent; anyone else → refused.
    resolveActorId: async (agentUserId: string | undefined, userId: string) =>
      !agentUserId
        ? { actorId: userId }
        : agentUserId === OWN_AGENT
          ? { actorId: agentUserId }
          : { error: "Not authorized to act as this agentUserId" },
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: { users: { findFirst: vi.fn(async () => ({ name: "Raycast" })) } },
    },
  };
});

vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: (...args: unknown[]) =>
    createProposalMock(...args),
}));

vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: { create: (...args: unknown[]) => notifyMock(...args) },
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerVaultRoutes } from "./vault.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(keyAgent?: string): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (keyAgent)
      (c as unknown as { set: (k: string, v: unknown) => void }).set(
        "agentUserId",
        keyAgent
      );
    await next();
  });
  registerVaultRoutes(app);
  return app;
}

const request = (app: HubHono, extra: Record<string, unknown> = {}) =>
  app.request("/vault/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      secretType: "api_key",
      service: "github",
      purpose: "open a PR",
      ...extra,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  createProposalMock.mockResolvedValue({ proposal: { id: "prop-v1" } });
  notifyMock.mockResolvedValue(undefined);
});

describe("POST /vault/request — the actor is one the caller holds", () => {
  it("a forged body agentUserId is refused before any proposal or banner", async () => {
    const res = await request(buildApp(), { agentUserId: FORGED });
    expect(res.status).toBe(400);
    expect(createProposalMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("an agent key (no body id) files as its own agent, owned by its human", async () => {
    const res = await request(buildApp(OWN_AGENT));
    expect(res.status).toBe(200);
    const input = createProposalMock.mock.calls[0][0];
    expect(input).toMatchObject({
      userId: USER_ID,
      agentUserId: OWN_AGENT,
      createdBy: OWN_AGENT,
    });
    expect(input.data.sourceId).toBe(OWN_AGENT);
    // The banner goes to the human who approves — never a body-named user.
    expect(notifyMock.mock.calls[0][0].userId).toBe(USER_ID);
  });

  it("a human session files as the human, with no agent", async () => {
    const res = await request(buildApp());
    expect(res.status).toBe(200);
    const input = createProposalMock.mock.calls[0][0];
    expect(input).toMatchObject({
      userId: USER_ID,
      agentUserId: null,
      createdBy: USER_ID,
    });
    expect(input.data.sourceId).toBe(USER_ID);
  });
});
