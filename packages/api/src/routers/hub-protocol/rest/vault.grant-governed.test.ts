/**
 * POST /vault/secrets/:id/grant is GOVERNED (2026-10-06 centralisation audit),
 * and its `vault/grant` approval half really grants.
 *
 * THE DEFECT. The door's only check was "secret owner == acting user". For an
 * agent key the acting user is the linked HUMAN, so an agent could insert a
 * permanent, auto-mode redeem grant to any of its human's secrets — for itself —
 * with no proposal, bypassing the /vault/request approval flow.
 *
 * WHAT IS ASSERTED (reachability, not shape):
 *  1. The door files `vault` + `grant` with the AGENT attributed, and on a
 *     `proposed` verdict answers 202 and INSERTS NOTHING.
 *  2. A human owner (no agent) still grants directly — `synap bridge-setup`
 *     run with a personal token keeps working.
 *  3. An identical active grant is reused BEFORE the gate (no duplicate
 *     proposal on a re-run).
 *  4. The approval half inserts the grant as the approver, refuses a
 *     non-owner approver, and inserts nothing then.
 *
 * NOT COVERED HERE: that `vault.grant` actually proposes for an agent — that is
 * the ADMIN floor, pinned in @synap/governance-policy `vault-grant-floor.test.ts`.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const BRIDGE = "33333333-3333-4333-8333-333333333333";
const SECRET = "44444444-4444-4444-8444-444444444444";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";

const h = vi.hoisted(() => ({
  secretOwner: "11111111-1111-4111-8111-111111111111" as string | null,
  activeGrant: null as Record<string, unknown> | null,
  inserts: [] as Array<Record<string, unknown>>,
  gateVerdict: { granted: true } as Record<string, unknown>,
  gateCalls: [] as Array<Record<string, unknown>>,
  proposalStatus: "pending",
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: {
        secrets: {
          findFirst: vi.fn(async () =>
            h.secretOwner ? { id: SECRET, userId: h.secretOwner } : undefined
          ),
        },
        vaultGrants: {
          findFirst: vi.fn(async () => h.activeGrant ?? undefined),
        },
      },
      insert: vi.fn(() => ({
        values: (v: Record<string, unknown>) => {
          h.inserts.push(v);
          return { returning: async () => [{ id: "grant-1" }] };
        },
      })),
      select: vi.fn(() => ({
        from: () => ({ where: async () => [{ status: h.proposalStatus }] }),
      })),
      update: vi.fn(() => ({ set: () => ({ where: async () => [] }) })),
    },
  };
});

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
    h.gateCalls.push(opts);
    return h.gateVerdict;
  }),
}));

import { registerVaultRoutes } from "./vault.js";
import { registerVaultExecutors } from "../../proposals/executors/vault.js";
import { proposalExecRegistry } from "../../proposals/execution-registry.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(asAgent: boolean): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    c.set("userId", HUMAN);
    if (asAgent) c.set("agentUserId", AGENT);
    await next();
  });
  registerVaultRoutes(app);
  return app;
}

const grant = (asAgent: boolean) =>
  buildApp(asAgent).request(`/vault/secrets/${SECRET}/grant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grantedTo: BRIDGE, scope: "permanent" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.secretOwner = HUMAN;
  h.activeGrant = null;
  h.inserts.length = 0;
  h.gateVerdict = { granted: true };
  h.gateCalls.length = 0;
  h.proposalStatus = "pending";
});

describe("the door", () => {
  it("files vault/grant with the agent attributed, and inserts nothing on propose", async () => {
    h.gateVerdict = { proposalId: PROPOSAL };
    const res = await grant(true);

    expect(res.status).toBe(202);
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      userId: HUMAN,
      agentUserId: AGENT,
      subjectType: "vault",
      action: "grant",
      data: expect.objectContaining({ secretId: SECRET, grantedTo: BRIDGE }),
    });
    expect(h.inserts).toHaveLength(0);
  });

  it("lets the human owner grant directly", async () => {
    const res = await grant(false);
    expect(res.status).toBe(200);
    expect(h.inserts).toEqual([
      expect.objectContaining({ grantableId: SECRET, grantedTo: BRIDGE }),
    ]);
  });

  it("reuses an identical active grant before the gate", async () => {
    h.activeGrant = { id: "existing", scope: "permanent", expiresAt: null };
    const res = await grant(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ reused: true });
    expect(h.gateCalls).toHaveLength(0);
    expect(h.inserts).toHaveLength(0);
  });
});

describe("the vault/grant approval half", () => {
  registerVaultExecutors();
  const run = (approver: string) =>
    proposalExecRegistry.resolve("vault/grant")!.execute({
      proposal: {
        id: PROPOSAL,
        targetId: SECRET,
        workspaceId: null,
        data: {
          data: {
            secretId: SECRET,
            grantedTo: BRIDGE,
            workspaceId: null,
            scope: "permanent",
            ttlMinutes: null,
          },
        },
      },
      userId: approver,
      input: { proposalId: PROPOSAL },
      deps: {
        reportProposalOutcome: vi.fn(),
        emitProposalReviewed: vi.fn(),
      },
    } as never);

  it("inserts the grant as the approving owner", async () => {
    await expect(run(HUMAN)).resolves.toMatchObject({ success: true });
    expect(h.inserts).toEqual([
      expect.objectContaining({
        grantableId: SECRET,
        grantedTo: BRIDGE,
        createdBy: HUMAN,
      }),
    ]);
  });

  it("refuses an approver who does not own the secret", async () => {
    await expect(run(AGENT)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.inserts).toHaveLength(0);
  });
});
