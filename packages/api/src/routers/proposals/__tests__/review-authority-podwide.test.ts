/**
 * POD-WIDE reject/reopen authority (security).
 *
 * `assertCanReviewProposal` — the gate `proposals.reject`, `proposals.reopen`
 * and `proposals.batchReject` share — used to open with
 * `if (!proposal.workspaceId) return;`: an UNCONDITIONAL ALLOW for every
 * pod-wide proposal, while its own doc comment claimed to mirror `approve`.
 * `approve` (`computeCanReviewApproval`) had since been hardened to
 * owner / agent-owner / pod-admin, so ANY authenticated pod user could reject —
 * or REOPEN (resurrect a rejected `cell/define` / `capability.install` back to
 * PENDING) — someone else's pod-wide proposal.
 *
 * These are EXECUTABLE (the module's DB access is mocked), so they fail on the
 * old `return;` and pass on the delegation to `computeCanReviewApproval`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB stub ────────────────────────────────────────────────────────────────
// review-authority only ever runs `select(...).from(T).where(...).limit(1)`
// (users / workspaces) plus `getWorkspaceMembership`.
const usersRow: { createdByUserId: string | null }[] = [];
const workspacesRow: { settings: unknown }[] = [];
let membership: { role: string } | undefined;
let podAdmin = false;

const USERS = { __table: "users" } as const;
const WORKSPACES = { __table: "workspaces" } as const;

vi.mock("@synap/database", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => (table === USERS ? usersRow : workspacesRow),
        }),
      }),
    }),
  },
  eq: () => ({}),
  users: USERS,
  getWorkspaceMembership: async () => membership,
}));

vi.mock("@synap/database/schema", () => ({ workspaces: WORKSPACES }));

vi.mock("../../../utils/workspace-role.js", () => ({
  isPodAdmin: async () => podAdmin,
}));

const { assertCanReviewProposal, computeCanReviewApproval } =
  await import("../review-authority.js");

const OWNER = "human-owner";
const STRANGER = "some-other-pod-user";
const AGENT = "agent-user-id";

beforeEach(() => {
  usersRow.length = 0;
  workspacesRow.length = 0;
  membership = undefined;
  podAdmin = false;
});

const podWide = (data: Record<string, unknown>, agentUserId?: string) => ({
  workspaceId: null,
  data,
  ...(agentUserId ? { agentUserId } : {}),
});

describe("pod-wide reject/reopen is gated (was an unconditional allow)", () => {
  for (const action of ["reject", "reopen"] as const) {
    it(`DENIES a stranger ${action}ing a pod-wide proposal`, async () => {
      await expect(
        assertCanReviewProposal({
          proposal: podWide({ sourceId: OWNER }),
          userId: STRANGER,
          action,
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it(`ALLOWS the proposal's own author to ${action} it`, async () => {
      await expect(
        assertCanReviewProposal({
          proposal: podWide({ sourceId: OWNER }),
          userId: OWNER,
          action,
        })
      ).resolves.toBeUndefined();
    });

    it(`ALLOWS the human who OWNS the acting agent to ${action} it`, async () => {
      // Agent-authored: `sourceId` is the agent, never the human.
      usersRow.push({ createdByUserId: OWNER });
      await expect(
        assertCanReviewProposal({
          proposal: podWide({ sourceId: AGENT }, AGENT),
          userId: OWNER,
          action,
        })
      ).resolves.toBeUndefined();
    });

    it(`ALLOWS a pod-admin to ${action} it`, async () => {
      podAdmin = true;
      await expect(
        assertCanReviewProposal({
          proposal: podWide({ sourceId: OWNER }),
          userId: STRANGER,
          action,
        })
      ).resolves.toBeUndefined();
    });
  }

  it("REOPEN is bounded by APPROVE — identical verdict for the same principal", async () => {
    // Reopen is the resurrection primitive: it returns a rejected proposal to
    // PENDING, where one further approval materializes the write. Anyone who
    // may approve can already cause that effect, and nobody else may reopen.
    const proposal = podWide({ sourceId: OWNER });
    const { allowed } = await computeCanReviewApproval({
      proposal,
      userId: STRANGER,
    });
    expect(allowed).toBe(false);
    await expect(
      assertCanReviewProposal({ proposal, userId: STRANGER, action: "reopen" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("workspace-scoped review is unchanged (same ladder as approve)", () => {
  it("admits a workspace admin", async () => {
    workspacesRow.push({ settings: {} });
    membership = { role: "admin" };
    await expect(
      assertCanReviewProposal({
        proposal: { workspaceId: "ws-1", data: { sourceId: OWNER } },
        userId: STRANGER,
        action: "reject",
      })
    ).resolves.toBeUndefined();
  });

  it("denies a plain viewer under the default owner_and_admins policy", async () => {
    workspacesRow.push({ settings: {} });
    membership = { role: "viewer" };
    await expect(
      assertCanReviewProposal({
        proposal: { workspaceId: "ws-1", data: { sourceId: OWNER } },
        userId: STRANGER,
        action: "reject",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
