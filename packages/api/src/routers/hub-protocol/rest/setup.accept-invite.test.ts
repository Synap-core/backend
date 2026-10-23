/**
 * `POST /setup/accept-invite` (the console's "Create account" on an invite)
 * never deletes or re-passwords an account that already exists.
 *
 * It used to: on a Kratos 409 it deleted the identity (and its users row) of
 * any account for the invited email with no workspace membership, then created
 * a new one with the password typed by whoever held the invite token. An
 * inviter names the email, so an inviter could take over a membership-less
 * account (a pod member of a pod with no space, a linked Synap account, the
 * author of data). Now a 409 is answered `ACCOUNT_EXISTS` and the person signs
 * in to accept (`acceptInvite`, `workspaces.invites-refusals.pglite.test.ts`).
 *
 * Mocked: Kratos admin (to OBSERVE deletes), the db (an open invite and a
 * membership-less user for the same email: the exact case that was deleted),
 * the connection cleanup the old path ran first.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const EXISTING = "0aaaaaaa-0000-4000-8000-000000000001";
const FRESH = "0bbbbbbb-0000-4000-8000-000000000002";
const WS = "2aaaaaaa-0000-4000-8000-000000000001";
const TOKEN = "t".repeat(64);
const EMAIL = "dormant@example.com";

const createIdentity = vi.fn();
const deleteIdentity = vi.fn(async () => ({}));
const listIdentities = vi.fn(async () => ({ data: [{ id: EXISTING }] }));
const dbDelete = vi.fn(() => ({ where: async () => undefined }));
const dbInsert = vi.fn(() => ({ values: async () => undefined }));
const disconnectAllUserConnections = vi.fn(async () => undefined);
const acceptInviteFor = vi.fn(async () => ({
  status: "accepted",
  type: "workspace",
  workspaceId: WS,
}));
const ensureUserRow = vi.fn(async () => undefined);

const openInvite = () => ({
  id: "i-1",
  type: "workspace",
  workspaceId: WS,
  email: EMAIL,
  role: "editor",
  token: TOKEN,
  expiresAt: new Date(Date.now() + 60_000),
});

vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  kratosAdmin: { createIdentity, deleteIdentity, listIdentities },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        invites: { findFirst: vi.fn(async () => openInvite()) },
        // An account for the invited email exists, with NO membership.
        users: { findFirst: vi.fn(async () => ({ id: EXISTING })) },
        workspaceMembers: { findFirst: vi.fn(async () => undefined) },
        workspaces: { findMany: vi.fn(async () => []) },
      },
      delete: dbDelete,
      insert: dbInsert,
    },
  };
});
vi.mock("../../../scripts/create-admin-user.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureUserRow,
}));
// The accept itself is the one door's job, driven for real in
// `workspaces.accept-invite-door.pglite.test.ts`; here it is only observed.
vi.mock("../../workspaces/accept-invite-for.js", () => ({ acceptInviteFor }));
vi.mock(
  "../../../services/capabilities/capability-nango-sync.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    disconnectAllUserConnections,
  })
);

const { registerSetupRoutes } = await import("./setup.js");

const accept = (body: Record<string, unknown>) => {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app.request("/setup/accept-invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
};

const BODY = {
  email: EMAIL,
  password: "chosen-by-token-holder",
  inviteToken: TOKEN,
};

beforeEach(() => {
  for (const m of [
    createIdentity,
    deleteIdentity,
    listIdentities,
    dbDelete,
    dbInsert,
    disconnectAllUserConnections,
    acceptInviteFor,
    ensureUserRow,
  ])
    m.mockClear();
});

describe("POST /setup/accept-invite", () => {
  it("positive control: a new email gets an account and joins", async () => {
    createIdentity.mockResolvedValueOnce({ data: { id: FRESH } });
    const res = await accept(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: FRESH, success: true });
    expect(acceptInviteFor).toHaveBeenCalledWith(
      expect.objectContaining({ id: "i-1" }),
      { id: FRESH, email: EMAIL }
    );
  });

  it("an existing account is answered ACCOUNT_EXISTS and is never deleted or replaced", async () => {
    createIdentity.mockRejectedValue({ response: { status: 409 } });
    const res = await accept(BODY);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "ACCOUNT_EXISTS" });
    expect(deleteIdentity).not.toHaveBeenCalled();
    expect(disconnectAllUserConnections).not.toHaveBeenCalled();
    expect(dbDelete).not.toHaveBeenCalled();
    // No second identity with the token holder's password.
    expect(createIdentity).toHaveBeenCalledTimes(1);
    // And the invite is not spent.
    expect(acceptInviteFor).not.toHaveBeenCalled();
    createIdentity.mockReset();
  });

  it("an invite for another email is refused before any account work", async () => {
    const res = await accept({ ...BODY, email: "mallory@example.com" });
    expect(res.status).toBe(403);
    expect(createIdentity).not.toHaveBeenCalled();
  });
});
