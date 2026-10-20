/**
 * S6 (founder, 2026-10-20) — `POST /knowledge` is a GOVERNED create.
 *
 * THE DEFECT. The door inserted a pod-wide runbook (`knowledge_keys`, recalled
 * by every agent in every space) with no gate at all: any hub key — a
 * read-only one included — wrote one, and an agent's write never reached the
 * person's review rules.
 *
 * WHAT IS ASSERTED (reachability, not shape):
 *  1. The door files `knowledgeKey` + `create` through `checkPermissionOrPropose`
 *     with the agent attributed; a `proposed` verdict answers 202 with the
 *     review link and INSERTS NOTHING (proposed is success — `synap capture
 *     --global` with an agent key keeps working).
 *  2. A denial (the key's grant, rung 0) answers 403 and inserts nothing.
 *  3. A granted verdict (a person) creates the row.
 *  4. The grant half: `knowledgeKey` folds to `document`, so a key that may
 *     create documents (the AI preset, minted before the door existed) may
 *     ask; a read-only key may not.
 *  5. The approval half creates the row from the stored payload.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";

const h = vi.hoisted(() => ({
  creates: [] as Array<Record<string, unknown>>,
  gateVerdict: { granted: true } as Record<string, unknown>,
  gateCalls: [] as Array<Record<string, unknown>>,
  proposalStatus: "pending",
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    knowledgeKeysRepository: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        h.creates.push(input);
        return { id: "kk-1", ...input };
      }),
    },
    db: {
      select: vi.fn(() => ({
        from: () => ({ where: async () => [{ status: h.proposalStatus }] }),
      })),
      update: vi.fn(() => ({ set: () => ({ where: async () => [] }) })),
    },
  };
});

vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
    h.gateCalls.push(opts);
    return h.gateVerdict;
  }),
}));

const { registerKnowledgeRoutes } = await import("./knowledge.js");
const { registerKnowledgeKeyExecutors } =
  await import("../../proposals/executors/knowledge-key.js");
const { proposalExecRegistry } =
  await import("../../proposals/execution-registry.js");
const { grantWriteDenial } =
  await import("../../../utils/grant-write-check.js");
import type { HubHono, HubVariables } from "./_shared.js";

function create(asAgent: boolean) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    c.set("userId", HUMAN);
    if (asAgent) c.set("agentUserId", AGENT);
    await next();
  });
  registerKnowledgeRoutes(app);
  return app.request("/knowledge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // The `synap capture --global` body (synap-cli commands/knowledge.ts).
    body: JSON.stringify({
      key: "deploy:backend",
      namespace: "deploy",
      slug: "backend",
      value: "Run the release script.",
      author: HUMAN,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.creates.length = 0;
  h.gateCalls.length = 0;
  h.gateVerdict = { granted: true };
  h.proposalStatus = "pending";
});

describe("POST /knowledge — through the gate", () => {
  it("files knowledgeKey/create with the agent attributed; proposed → 202, nothing written", async () => {
    h.gateVerdict = {
      proposalId: PROPOSAL,
      reviewUrl: `https://pod/open/${PROPOSAL}`,
    };
    const res = await create(true);
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "proposed", proposalId: PROPOSAL });
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      userId: HUMAN,
      agentUserId: AGENT,
      workspaceId: null,
      subjectType: "knowledgeKey",
      action: "create",
      data: expect.objectContaining({
        key: "deploy:backend",
        value: "Run the release script.",
      }),
    });
    expect(h.creates).toHaveLength(0);
  });

  it("a denied key (its grant) → 403, nothing written", async () => {
    h.gateVerdict = { denied: true, reason: "This key's grant does not allow" };
    const res = await create(true);
    expect(res.status).toBe(403);
    expect(h.creates).toHaveLength(0);
  });

  it("CONTROL — a person (granted) writes the runbook directly", async () => {
    const res = await create(false);
    expect(res.status).toBe(200);
    expect(h.creates).toEqual([
      expect.objectContaining({ key: "deploy:backend" }),
    ]);
  });
});

describe("the grant half (rung 0): knowledgeKey folds to document", () => {
  const scope = (permissions: readonly string[]) =>
    ({ scopes: [{ permissions }], clientId: null }) as never;
  const AI = GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!.grant
    .permissions;
  it("the AI preset may ask; a read-only key may not", async () => {
    const req = { subjectType: "knowledgeKey", action: "create" };
    expect(await grantWriteDenial(req, scope(AI))).toBeNull();
    expect(await grantWriteDenial(req, scope(["document.create"]))).toBeNull();
    expect(
      await grantWriteDenial(req, scope(["entity.read", "document.read"]))
    ).not.toBeNull();
  });
});

describe("the approval half", () => {
  it("creates the runbook from the stored payload", async () => {
    registerKnowledgeKeyExecutors();
    const exec = proposalExecRegistry.resolveExact("knowledgeKey/create");
    expect(exec).toBeDefined();
    const deps = {
      reportProposalOutcome: vi.fn(),
      emitProposalReviewed: vi.fn(),
    };
    await exec!.execute({
      proposal: {
        id: PROPOSAL,
        workspaceId: null,
        agentUserId: AGENT,
        data: { data: { key: "deploy:backend", value: "Run it." } },
      },
      userId: HUMAN,
      input: { proposalId: PROPOSAL },
      deps,
    } as never);
    expect(h.creates).toEqual([
      expect.objectContaining({
        key: "deploy:backend",
        value: "Run it.",
        author: AGENT,
      }),
    ]);
  });
});
