/**
 * `mayActAsUser` / `resolveActingContext` — the ONE body/query `userId` rule for
 * hub REST, exercised on the REAL helper (not mocked).
 *
 * THE DEFECT: the helper treated `!!c.get("apiKeyId")` as "service key", but the
 * auth middleware sets `apiKeyId` for EVERY bearer key — so an agent
 * (`hub_inbound`) key could post `{ userId: <victim> }` with no workspace and the
 * write executed (and was governed) AS the victim.
 *
 * A key may name exactly the identities it holds (itself, its own agent
 * principal); only `is_internal` / `system` / `service` may name anyone; a
 * bearer context with no `keyType` fails closed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const AGENT = "0ccccccc-0000-4000-8000-000000000003";
const VICTIM = "0bbbbbbb-0000-4000-8000-000000000002";
const WS = "0ddddddd-0000-4000-8000-000000000004";

const membership = vi.fn();

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getWorkspaceMembership: (...args: unknown[]) => membership(...args),
  };
});

const { mayActAsUser, resolveActingContext } = await import("./_shared.js");

function ctx(vars: Record<string, unknown>) {
  return { get: (k: string) => vars[k] };
}

const agentKey = {
  userId: HUMAN,
  apiKeyId: "key-1",
  keyType: "hub_inbound",
  agentUserId: AGENT,
};

beforeEach(() => {
  membership.mockReset();
});

describe("resolveActingContext — body.userId is bound to identities the caller holds", () => {
  it("hub_inbound key naming a third user → 403", async () => {
    const r = await resolveActingContext(ctx(agentKey), { userId: VICTIM });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(membership).not.toHaveBeenCalled();
  });

  it("user_pat key naming a third user → 403", async () => {
    const r = await resolveActingContext(
      ctx({ userId: HUMAN, apiKeyId: "key-2", keyType: "user_pat" }),
      { userId: VICTIM }
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("session caller (no apiKeyId) naming a third user → 403", async () => {
    const r = await resolveActingContext(ctx({ userId: HUMAN }), {
      userId: VICTIM,
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it.each(["service", "system", "is_internal"])(
    "allowlisted %s key naming a different user → acts as that user",
    async (keyType) => {
      const r = await resolveActingContext(
        ctx({ userId: HUMAN, apiKeyId: "key-3", keyType }),
        { userId: VICTIM }
      );
      expect(r).toEqual({
        ok: true,
        userId: VICTIM,
        workspaceId: null,
        role: "owner",
      });
    }
  );

  it("allowlisted key's on-behalf-of user is still membership-checked for a workspace write", async () => {
    membership.mockResolvedValue(null);
    const r = await resolveActingContext(
      ctx({ userId: HUMAN, apiKeyId: "key-3", keyType: "service" }),
      { userId: VICTIM, workspaceId: WS }
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(membership).toHaveBeenCalledWith(expect.anything(), WS, VICTIM);
  });

  it("hub_inbound key naming the authenticated user → allowed", async () => {
    const r = await resolveActingContext(ctx(agentKey), { userId: HUMAN });
    expect(r).toMatchObject({ ok: true, userId: HUMAN });
  });

  it("hub_inbound key naming its OWN agent principal → allowed, acts as the agent", async () => {
    const r = await resolveActingContext(ctx(agentKey), { userId: AGENT });
    expect(r).toMatchObject({ ok: true, userId: AGENT });
  });

  it("no body.userId → acts as the authenticated user", async () => {
    const r = await resolveActingContext(ctx(agentKey), {});
    expect(r).toMatchObject({ ok: true, userId: HUMAN, workspaceId: null });
  });

  it("apiKeyId with a missing keyType fails CLOSED when naming another user", async () => {
    const r = await resolveActingContext(
      ctx({ userId: HUMAN, apiKeyId: "legacy-key" }),
      { userId: VICTIM }
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
});

describe("mayActAsUser — edge cases of the shared predicate", () => {
  it("no authenticated user → never", () => {
    expect(mayActAsUser(ctx({}), undefined)).toBe(false);
  });

  it("an agentUserId is only honoured as an exact match, never as a wildcard", () => {
    expect(mayActAsUser(ctx({ ...agentKey, agentUserId: undefined }), AGENT)).toBe(
      false
    );
    expect(mayActAsUser(ctx(agentKey), "")).toBe(true); // empty = not naming anyone
  });

  it("an unknown keyType is not an override type", () => {
    expect(
      mayActAsUser(
        ctx({ userId: HUMAN, apiKeyId: "k", keyType: "made_up" }),
        VICTIM
      )
    ).toBe(false);
  });
});
