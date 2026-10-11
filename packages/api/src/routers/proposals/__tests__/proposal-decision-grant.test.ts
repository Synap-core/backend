/**
 * The KEY half of deciding a proposal, driven through the REAL decision doors.
 *
 * A request authenticated by a granted key may approve / reject only when one
 * of its live scopes names the verb (`*` or `proposal.<verb>`). A key granted
 * "read documents" used to approve anything, with the human's authority.
 *
 * Seam: the grant is entered exactly as the key-auth doors enter it
 * (`runWithGrant`), and each door is called through `createCaller` — nothing
 * hand-built between the grant and the refusal. `db` is a tripwire: the gate
 * is the first statement of every door, so a refused call must never reach it
 * and an allowed call must (that is how "allowed" is told from "refused").
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ armed: false, reached: false }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = new Proxy(
    {},
    {
      get() {
        if (!h.armed) return undefined;
        h.reached = true;
        throw new Error("DB_REACHED");
      },
    }
  );
  return { ...actual, db };
});
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

const { runWithGrant } = await import("@synap/database");
const { proposalsRouter } = await import("../../proposals.js");
const { secretsVaultRouter } = await import("../../secrets-vault.js");
const { applyProposalApproval } = await import("../apply-approval.js");
type KeyGrant = NonNullable<Parameters<typeof runWithGrant>[0]>;

const ID = "8f6b1c2e-3d4a-4b5c-9d6e-7f8091a2b3c4";
const grant = (...scopes: string[][]): KeyGrant => ({
  scopes: scopes.map((permissions) => ({ permissions })),
  clientId: null,
});
const NARROW = grant(["document.read"]);
const APPROVE_ONLY = grant(["proposal.approve"]);
const REJECT_ONLY = grant(["proposal.reject"]);
const FULL = grant(["*"]);
/** A bare subject is read/create/update/delete only — never a decision. */
const BARE = grant(["proposal"]);
const REVOKED = grant([]);
/** Two scopes: neither alone is "everything", the second names reject. */
const SPLIT = grant(["document.read"], ["proposal.reject"]);

const keyCtx = {
  authenticated: true,
  userId: "user-1",
  user: null,
  session: null,
  req: undefined,
  workspaceId: null,
  apiKeyId: "key-1",
} as never;
const sessionCtx = {
  authenticated: true,
  userId: "user-1",
  user: { id: "user-1" },
  session: { id: "kratos-session" },
  req: undefined,
  workspaceId: null,
} as never;

type Door = {
  name: string;
  verb: "approve" | "reject";
  call: (ctx: never) => Promise<unknown>;
};
const p = (ctx: never) => proposalsRouter.createCaller(ctx);
const DOORS: Door[] = [
  {
    name: "approve",
    verb: "approve",
    call: (c) => p(c).approve({ proposalId: ID }),
  },
  {
    name: "revise",
    verb: "approve",
    call: (c) => p(c).revise({ proposalId: ID, data: {} }),
  },
  {
    name: "batchApprove",
    verb: "approve",
    call: (c) => p(c).batchApprove({ proposalIds: [ID] }),
  },
  {
    name: "revert",
    verb: "approve",
    call: (c) => p(c).revert({ proposalId: ID }),
  },
  {
    name: "secretsVault.grantAIAccess",
    verb: "approve",
    call: (c) =>
      secretsVaultRouter
        .createCaller(c)
        .grantAIAccess({ secretId: ID, proposalId: ID }),
  },
  {
    name: "reject",
    verb: "reject",
    call: (c) => p(c).reject({ proposalId: ID }),
  },
  {
    name: "batchReject",
    verb: "reject",
    call: (c) => p(c).batchReject({ proposalIds: [ID] }),
  },
  {
    name: "rejectItem",
    verb: "reject",
    call: (c) => p(c).rejectItem({ proposalId: ID, itemRef: "$op0" }),
  },
  {
    name: "restoreItem",
    verb: "reject",
    call: (c) => p(c).restoreItem({ proposalId: ID, itemRef: "$op0" }),
  },
  {
    name: "reopen",
    verb: "reject",
    call: (c) => p(c).reopen({ proposalId: ID }),
  },
];

async function attempt(door: Door, g: KeyGrant | null, ctx = keyCtx) {
  h.reached = false;
  const err = await runWithGrant(g, () => door.call(ctx)).then(
    () => null,
    (e: unknown) => e as { code?: string; message?: string }
  );
  const refused =
    err?.code === "FORBIDDEN" && /^This key may not /.test(err.message ?? "");
  return { err, refused, reached: h.reached };
}

beforeEach(() => {
  h.armed = true;
});

describe.each(DOORS)("$name — needs proposal.$verb", (door) => {
  it("a key granted only 'read documents' is refused, before any read", async () => {
    const r = await attempt(door, NARROW);
    expect(r.refused).toBe(true);
    expect(r.err?.message).toContain(`Give it the '${door.verb}' right`);
    expect(r.reached).toBe(false);
  });

  it("a revoked/expired grant (deny-all scope) is refused", async () => {
    const r = await attempt(door, REVOKED);
    expect(r.refused).toBe(true);
    expect(r.reached).toBe(false);
  });

  it("the OTHER decision verb does not cover this one", async () => {
    const r = await attempt(
      door,
      door.verb === "approve" ? REJECT_ONLY : APPROVE_ONLY
    );
    expect(r.refused).toBe(true);
    expect(r.reached).toBe(false);
  });

  it("a bare `proposal` grant does not decide", async () => {
    const r = await attempt(door, BARE);
    expect(r.refused).toBe(true);
    expect(r.reached).toBe(false);
  });

  it("proposal.<verb> passes the gate", async () => {
    const r = await attempt(
      door,
      door.verb === "approve" ? APPROVE_ONLY : REJECT_ONLY
    );
    expect(r.refused).toBe(false);
    expect(r.reached).toBe(true);
  });

  it("'*' (full access) passes the gate", async () => {
    const r = await attempt(door, FULL);
    expect(r.refused).toBe(false);
    expect(r.reached).toBe(true);
  });

  it("a never-granted (legacy) key passes — unchanged until P5", async () => {
    const r = await attempt(door, null);
    expect(r.refused).toBe(false);
    expect(r.reached).toBe(true);
  });

  it("a person's own session is never restricted by key grants", async () => {
    const r = await attempt(door, null, sessionCtx);
    expect(r.refused).toBe(false);
    expect(r.reached).toBe(true);
  });
});

describe("every live scope of a key counts", () => {
  it("a key whose SECOND scope names reject may reject, not approve", async () => {
    const reject = DOORS.find((d) => d.name === "reject")!;
    const approve = DOORS.find((d) => d.name === "approve")!;
    expect((await attempt(reject, SPLIT)).refused).toBe(false);
    expect((await attempt(approve, SPLIT)).refused).toBe(true);
  });
});

describe("applyProposalApproval — the shared approve core (import apply reaches it)", () => {
  it("refuses a key without proposal.approve before executing anything", async () => {
    h.reached = false;
    const run = () =>
      applyProposalApproval({
        proposal: { id: ID } as never,
        userId: "user-1",
        input: { proposalId: ID },
        ctx: keyCtx,
      });
    await expect(runWithGrant(NARROW, run)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "This key may not approve changes. Give it the 'approve' right in its access.",
    });
    expect(h.reached).toBe(false);
  });
});
