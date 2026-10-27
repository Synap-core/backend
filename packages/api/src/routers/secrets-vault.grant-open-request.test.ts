/**
 * `secretsVault.grantAIAccess` (the desktop vault card) grants only an OPEN
 * request.
 *
 * THE DEFECT (founder, 2026-10-27). The card stayed on screen after its
 * request was rejected elsewhere, and the door checked no status: a grant on a
 * decided request would have handed the agent the secret anyway. A request
 * that is still pending, or whose approval failed, stays grantable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "44444444-4444-4444-8444-444444444444";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  proposalStatus: "pending",
  inserts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: {
        secrets: {
          findFirst: vi.fn(async () => ({
            id: "44444444-4444-4444-8444-444444444444",
            userId: "11111111-1111-4111-8111-111111111111",
            encryptionMode: "server",
          })),
        },
        proposals: {
          findFirst: vi.fn(async () => ({
            id: "55555555-5555-4555-8555-555555555555",
            status: h.proposalStatus,
            data: { ttl: 60 },
            createdBy: "22222222-2222-4222-8222-222222222222",
            agentUserId: "22222222-2222-4222-8222-222222222222",
            workspaceId: null,
            projectId: null,
            targetId: "fal.ai:api_key",
          })),
        },
      },
      insert: vi.fn(() => ({
        values: (v: Record<string, unknown>) => {
          h.inserts.push(v);
          return { returning: async () => [{ id: "grant-1" }] };
        },
      })),
      update: vi.fn(() => ({ set: () => ({ where: async () => [] }) })),
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
// The read-only guard runs before every mutation; a writable pod here.
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

const { secretsVaultRouter } = await import("./secrets-vault.js");

const sessionCtx = {
  authenticated: true,
  userId: USER,
  user: { id: USER },
  session: { id: "kratos-session" },
  req: undefined,
  workspaceId: null,
} as never;

const grant = () =>
  secretsVaultRouter
    .createCaller(sessionCtx)
    .grantAIAccess({
      secretId: SECRET,
      proposalId: PROPOSAL,
      scope: "permanent",
    });

beforeEach(() => {
  h.proposalStatus = "pending";
  h.inserts.length = 0;
});

describe("grantAIAccess grants an open request only", () => {
  it("grants a pending request to the agent that asked (non-vacuity)", async () => {
    await expect(grant()).resolves.toMatchObject({ grantId: "grant-1" });
    expect(h.inserts).toEqual([
      expect.objectContaining({ grantableId: SECRET, grantedTo: AGENT }),
    ]);
  });

  it("a request whose approval failed is still grantable", async () => {
    h.proposalStatus = "approval_failed";
    await expect(grant()).resolves.toMatchObject({ grantId: "grant-1" });
  });

  it.each(["rejected", "approved", "withdrawn", "expired"])(
    "a %s request is refused and nothing is granted",
    async (status) => {
      h.proposalStatus = status;
      await expect(grant()).rejects.toMatchObject({ code: "CONFLICT" });
      expect(h.inserts).toHaveLength(0);
    }
  );
});
