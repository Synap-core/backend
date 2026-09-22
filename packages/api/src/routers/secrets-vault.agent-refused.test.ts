/**
 * `secretsVault.create` — minting a credential from FREE TEXT is a human act.
 *
 * ── WHY THIS FLOOR EXISTS ───────────────────────────────────────────────────
 * This is the door a reviewer uses on a `capability.install` review screen to
 * type a NEW key and receive a `vault://<id>` to put in `params`. Every other
 * vault write is "store the credential I already hold"; this one MINTS one. An
 * agent that could call it could plant a credential of its own choosing and
 * then propose the install that uses it — with the human reviewing only a ref,
 * which by design reveals nothing about the value behind it.
 *
 * ── THE SIGNAL IS THE AMBIENT ONE, AND THAT IS THE POINT ────────────────────
 * Three actor channels exist here and only one is unforgeable: a
 * request-supplied `agentUserId` can simply be omitted, and a header can be
 * dropped, but `runWithActingAgent`'s AsyncLocalStorage marker is set by the
 * key-auth middleware itself. So the floor reads `getActingAgentUserId()`, and
 * this test drives the REAL `runWithActingAgent` rather than a mock of it.
 *
 * ── AND THE READ DOOR IS DELIBERATELY NOT FLOORED ───────────────────────────
 * `secretsVault.list` returns names/ids/types and NEVER a value; it is the
 * "pick an existing secret" half of the same form. Flooring it would break the
 * pick-from-existing path for no security gain — there is nothing to steal in a
 * list of labels.
 */
import { describe, it, expect, vi } from "vitest";

const m = vi.hoisted(() => ({
  // The human path REALLY encrypts (`encryptServerSide`), which is the point —
  // this door mints a credential. A key is required for that call to run.
  _env: (process.env.VAULT_SERVER_KEY = "ab".repeat(32)),
  repoCreate: vi.fn(async () => ({
    id: "55555555-5555-5555-5555-555555555555",
    name: "Acme API Key",
    type: "api_key",
    createdAt: new Date("2026-09-21T00:00:00Z"),
  })),
  repoList: vi.fn(async () => []),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  // `protectedProcedure`'s middleware reads `sync_generation` before the
  // handler runs; the pod is REMOTE, so a local :5432 is not reachable here.
  // A resolving chain lets the REAL procedure + REAL middleware run, which is
  // what makes this a door test rather than a call to a bare function.
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [] as unknown[],
    then: (res: (v: unknown[]) => unknown) => Promise.resolve([]).then(res),
  };
  return {
    ...actual,
    db: {
      select: () => chain,
      insert: () => ({
        values: () => ({
          returning: async () => [],
          onConflictDoNothing: async () => undefined,
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve(undefined).then(res),
        }),
      }),
      update: () => {
        const upd = { set: () => upd, where: async () => undefined };
        return upd;
      },
      query: { syncGeneration: { findFirst: async () => undefined } },
    },
    SecretsVaultRepository: class {
      create = m.repoCreate;
      list = m.repoList;
    },
  };
});

import { runWithActingAgent } from "@synap/database";
import { secretsVaultRouter } from "./secrets-vault.js";

const UID = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";

const caller = () =>
  secretsVaultRouter.createCaller({
    db: {},
    authenticated: true as const,
    userId: UID,
    workspaceId: null,
  } as never);

const input = {
  name: "Acme API Key",
  type: "api_key" as const,
  value: "sk-live-minted-by-whoever-called",
};

describe("create — free-text credential minting", () => {
  it("REFUSES a caller acting as an agent", async () => {
    m.repoCreate.mockClear();
    await expect(
      runWithActingAgent(AGENT, () => caller().create(input))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Refused BEFORE any write — not refused after encrypting and inserting.
    expect(m.repoCreate).not.toHaveBeenCalled();
  });

  it("allows a human caller, and answers with the REF", async () => {
    m.repoCreate.mockClear();
    const out = await caller().create(input);
    expect(m.repoCreate).toHaveBeenCalledTimes(1);
    // The ref, not an id the caller must concatenate a scheme onto — that is
    // how a second spelling of the ref format gets written.
    expect(out.vaultRef).toBe("vault://55555555-5555-5555-5555-555555555555");
    // Metadata only. The value never comes back out of this door.
    expect(JSON.stringify(out)).not.toContain("sk-live");
    expect("value" in out).toBe(false);
  });

  it("the LIST door stays open to an agent and still carries no values", async () => {
    m.repoList.mockClear();
    const rows = await runWithActingAgent(AGENT, () => caller().list({}));
    expect(m.repoList).toHaveBeenCalled();
    expect(rows).toEqual([]);
  });
});
