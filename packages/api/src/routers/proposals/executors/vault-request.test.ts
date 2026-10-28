/**
 * An agent's `vault.request` can be APPROVED from every generic approve door
 * (pod console, phone, inbox) — they all reach `dispatchProposalApproval`.
 *
 * THE DEFECT (founder, 2026-10-27). Only `vault/grant` was registered, so the
 * dispatch answered "Proposal approval for type 'vault' is not yet
 * implemented" and the request was marked failed: the console could never
 * grant the fal.ai key the agent asked for.
 *
 * WHAT IS ASSERTED, through the real dispatcher (reachability):
 *  1. the one saved secret matching the request is granted to the AGENT that
 *     asked, in the request's space, for the minutes it asked (scope
 *     'session'), and the proposal records the `vault://` reference the
 *     agent's poll reads;
 *  2. a secret the request names (`secretId`) wins over the matcher;
 *  3. several matches, no match, or a named secret the approver does not own
 *     refuse with a sentence that says what to do, and grant nothing.
 *
 * NOT COVERED HERE: that only the APPROVER's secrets are candidates is the
 * `secrets.userId = approver` predicate of the query, which this mocked `db`
 * does not evaluate (it returns the rows the test hands it).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const APPROVER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";
const FAL = "27e17487-6212-4e9d-bc92-c98fbea58662";
const FAL2 = "66666666-6666-4666-8666-666666666666";
const OPENAI = "77777777-7777-4777-8777-777777777777";

const secretRow = (id: string, name: string, type = "api_key") => ({
  id,
  name,
  type,
  category: null,
  url: null,
  description: null,
});

const h = vi.hoisted(() => ({
  owned: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  proposalStatus: "pending",
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: {
        secrets: { findMany: vi.fn(async () => h.owned) },
        vaultGrants: { findFirst: vi.fn(async () => undefined) },
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
      update: vi.fn(() => ({
        set: (v: Record<string, unknown>) => {
          h.updates.push(v);
          return { where: async () => [] };
        },
      })),
    },
  };
});

const { registerVaultExecutors } = await import("./vault.js");
const { dispatchProposalApproval } = await import("../execution-registry.js");

registerVaultExecutors();

const approve = (data: Record<string, unknown>) =>
  dispatchProposalApproval(
    {
      proposal: {
        id: PROPOSAL,
        targetType: "vault",
        targetId: "fal.ai:api_key",
        proposalType: "vault.request",
        workspaceId: WS,
        sessionId: null,
        projectId: null,
        agentUserId: AGENT,
        createdBy: AGENT,
        sourceMessageId: null,
        data,
      },
      payload: null,
      userId: APPROVER,
      input: { proposalId: PROPOSAL },
      deps: {
        reportProposalOutcome: vi.fn(),
        emitProposalReviewed: vi.fn(),
      },
    } as never,
    vi.fn(async () => undefined)
  );

// The pod's own request shape (POST /vault/request), as stored on 2026-10-27.
const falRequest = {
  ttl: 60,
  service: "fal.ai",
  secretType: "api_key",
  purpose: "Run fal_generate_image",
  requestedBy: "ai",
  source: "agent",
};

beforeEach(() => {
  h.owned = [
    secretRow(FAL, "fal.ai Image Generation fal.ai API key"),
    secretRow(OPENAI, "OpenAI key"),
  ];
  h.inserts.length = 0;
  h.updates.length = 0;
  h.proposalStatus = "pending";
});

describe("approving a vault.request", () => {
  it("grants the one matching secret to the agent, for the minutes it asked", async () => {
    const before = Date.now();
    await expect(approve(falRequest)).resolves.toMatchObject({ success: true });

    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({
      grantableType: "secret",
      grantableId: FAL,
      grantedTo: AGENT,
      workspaceId: WS,
      scope: "session",
      createdBy: APPROVER,
    });
    const expiresAt = (h.inserts[0]!.expiresAt as Date).getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(59 * 60 * 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(61 * 60 * 1000);

    // The proposal is approved and carries what the agent's poll reads.
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      status: "approved",
      reviewedBy: APPROVER,
    });
    expect(JSON.stringify(h.updates[0]!.data)).toContain(`vault://${FAL}`);
  });

  it("a secret the request names wins over the matcher", async () => {
    h.owned = [
      secretRow(FAL, "fal.ai key (old)"),
      secretRow(FAL2, "fal.ai key (team)"),
    ];
    await approve({ ...falRequest, secretId: FAL2 });
    expect(h.inserts[0]).toMatchObject({ grantableId: FAL2 });
  });

  it("several matching secrets: refuses and says where to pick one", async () => {
    h.owned = [
      secretRow(FAL, "fal.ai key (old)"),
      secretRow(FAL2, "fal.ai key (team)"),
    ];
    await expect(approve(falRequest)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("2 secrets in your vault match fal.ai"),
    });
    expect(h.inserts).toHaveLength(0);
  });

  it("no matching secret: refuses and says to add it", async () => {
    h.owned = [secretRow(OPENAI, "OpenAI key")];
    await expect(approve(falRequest)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(
        "No secret in your vault matches fal.ai"
      ),
    });
    expect(h.inserts).toHaveLength(0);
  });

  it("a named secret that is not the approver's: refuses, grants nothing", async () => {
    await expect(
      approve({ ...falRequest, secretId: FAL2 })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.inserts).toHaveLength(0);
  });

  it("an already approved request is not granted twice", async () => {
    h.proposalStatus = "approved";
    await expect(approve(falRequest)).resolves.toMatchObject({
      alreadyApproved: true,
    });
    expect(h.inserts).toHaveLength(0);
  });
});
