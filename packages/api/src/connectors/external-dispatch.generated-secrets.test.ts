/**
 * A generated secret is minted only PAST the capability gate.
 *
 * The placeholder (`vault://generate?name=…`) rides into `triggerProviderAction`
 * with the rest of the call. Governance decides first:
 *  - `propose` → the proposal stores the PLACEHOLDER (what a reviewer and an
 *    agent can read), nothing is minted, nothing is sent;
 *  - `deny` → nothing is minted, nothing is sent;
 *  - `run` → the vault handler mints (the positive control: without it the two
 *    "never minted" assertions above would hold for a handler that never mints).
 *
 * Harness: the proposal-redaction suite's (db / gate / proposal-insert stubs),
 * with a vault:// tool and the minting door spied. Minting itself (storage,
 * scrubbing, logs) is pinned in `generated-secrets.pglite.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const TOKEN_ID = "11111111-1111-4111-8111-111111111111";
const TOOL_ROW = {
  id: "tool-vercel",
  name: "vercel",
  kind: "provider",
  approved: true,
  createdBy: "owner-1",
  credentialRef: `vault://${TOKEN_ID}`,
  authBinding: "static",
  workspaceId: null,
  config: { baseUrl: "https://api.vercel.example", generatedSecrets: true },
};
const inserted: any[] = [];
const gate = vi.hoisted(() => ({ decision: "propose" as string }));
const minted = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("../utils/vault-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveVaultSecret: async () => "provider-token-not-under-test",
}));
vi.mock("./generated-secrets.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeGeneratedSecrets: async (body: unknown) => {
    minted.calls.push(body);
    return { ok: true, body, values: [] };
  },
}));
vi.mock("../services/capabilities/gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({
    decision: gate.decision,
    reason: "not enabled",
  }),
}));
vi.mock("../services/capabilities/propose-capability-enable.js", () => ({
  resolveNotEnabledRefusal: async () => ({ message: "Nothing ran." }),
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: any) => {
    inserted.push(input);
    return { id: `prop-${inserted.length}` };
  },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveCapabilityGrant: async () => ({ ok: true }),
    db: {
      query: {
        secrets: {
          findFirst: async () => ({
            userId: "owner-1",
            providerIntegrationId: null,
            accountHint: null,
            isPodWide: false,
          }),
        },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [TOOL_ROW],
            then: (resolve: (v: unknown) => unknown) => resolve([TOOL_ROW]),
          }),
        }),
      }),
      insert: () => ({ values: async () => undefined }),
    },
  };
});

const fetchSpy = vi.fn(
  async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })
);
vi.stubGlobal("fetch", fetchSpy);

const { triggerProviderAction } = await import("./external-dispatch.js");

const PLACEHOLDER = "vault://generate?name=site:shop:AUTH_SECRET";
const CALL = {
  userId: "owner-1",
  agentUserId: "agent-1",
  provider: "vercel",
  method: "POST",
  path: "/v10/projects/shop/env",
  body: { key: "AUTH_SECRET", value: PLACEHOLDER, type: "sensitive" },
  workspaceId: "ws-1",
};

describe("triggerProviderAction — a generated secret is minted only past the gate", () => {
  beforeEach(() => {
    inserted.length = 0;
    minted.calls.length = 0;
    fetchSpy.mockClear();
  });

  it("propose: the proposal keeps the placeholder; nothing is minted or sent", async () => {
    gate.decision = "propose";
    const out = await triggerProviderAction(CALL);
    expect(out.proposed).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].data.body.value).toBe(PLACEHOLDER);
    expect(minted.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deny: nothing is minted or sent", async () => {
    gate.decision = "deny";
    const out = await triggerProviderAction(CALL);
    expect(out.success).toBe(false);
    expect(minted.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("run (positive control): the vault handler mints from the placeholder body", async () => {
    gate.decision = "run";
    const out = await triggerProviderAction(CALL);
    expect(out.success).toBe(true);
    expect(minted.calls).toEqual([CALL.body]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
