/**
 * Feed execution on a `cp-relay` source uses the pod's ONE current relay key
 * (`readCpRelayCredential`), not the `relayKey` copy stored on the row at
 * delivery time. The CP rotates by delivering a new row, so the copy goes stale.
 *
 * The DB, vault resolver, provider registry and queue are faked; the executor
 * runs for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  subscription: null as any,
  sourceConfig: null as any,
  credential: null as null | { key: string; expiresAt: Date | null },
  credentialError: null as unknown,
  vault: {} as Record<string, string>,
  fetch: vi.fn(),
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", () => {
  class CpRelayVaultUnresolvedError extends Error {
    readonly code = "vault-unresolved" as const;
    constructor(readonly unresolvedRows: number) {
      super("relay row present, vault reference unresolved");
    }
  }
  return {
    CpRelayVaultUnresolvedError,
    eq: () => "eq",
    readCpRelayCredential: async () => {
      if (h.credentialError) throw h.credentialError;
      return h.credential;
    },
    db: {
      query: {
        sourceSubscriptions: { findFirst: async () => h.subscription },
        sourceConfigs: { findFirst: async () => h.sourceConfig },
      },
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: async () => {
            h.updates.push(v);
          },
        }),
      }),
    },
  };
});

vi.mock("@synap/database/schema", () => ({
  sourceSubscriptions: { id: "id" },
  sourceConfigs: { id: "id" },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

vi.mock("@synap/feed-service", () => ({
  sourceProviderRegistry: { get: () => ({ fetch: h.fetch }) },
}));

vi.mock("@synap/events", () => ({
  getBoss: () => ({ send: async () => undefined }),
}));

vi.mock("../../utils/vault-resolver.js", () => ({
  resolveVaultReferences: async (flat: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(flat).map(([k, v]) => [
        k,
        v.startsWith("vault://") ? (h.vault[v] ?? "") : v,
      ])
    ),
}));

import { CpRelayVaultUnresolvedError } from "@synap/database";
import { handleFeedSourceExecute } from "../feed-source-executor.js";

function relaySource(params: Record<string, unknown> = {}) {
  h.subscription = {
    id: "sub-1",
    status: "active",
    sourceConfigId: "sc-1",
    params,
    cursor: null,
    lastItemAt: null,
    feedId: "feed-1",
    userId: "owner-1",
    workspaceId: null,
  };
  h.sourceConfig = {
    id: "sc-1",
    enabled: true,
    providerType: "cp-relay",
    userId: "owner-1",
    config: {
      relayUrl: "https://cp.example.test",
      relayKey: "vault://00000000-0000-0000-0000-000000000001",
    },
  };
}

const run = () =>
  handleFeedSourceExecute({ data: { subscriptionId: "sub-1" } });

beforeEach(() => {
  h.vault = { "vault://00000000-0000-0000-0000-000000000001": "stale-key" };
  h.credential = { key: "rotated-key", expiresAt: null };
  h.credentialError = null;
  h.fetch.mockReset();
  h.fetch.mockResolvedValue({ items: [], nextToken: undefined });
  h.updates = [];
});

describe("feed execution on a cp-relay source", () => {
  it("a rotated key reaches the provider, not the row's stale copy", async () => {
    relaySource();
    expect(await run()).toMatchObject({ ok: true });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0]![0]).toMatchObject({
      relayKey: "rotated-key",
    });
  });

  it("the derived-query fan-out carries the rotated key on every query", async () => {
    relaySource({
      derivedQueries: [
        { upstreamType: "hn", config: { q: "a" }, label: "A" },
        { upstreamType: "hn", config: { q: "b" }, label: "B" },
      ],
    });
    expect(await run()).toMatchObject({ ok: true });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    for (const [cfg] of h.fetch.mock.calls) {
      expect(cfg).toMatchObject({ relayKey: "rotated-key" });
    }
  });

  it("an unreadable relay key marks the subscription errored and fetches nothing", async () => {
    relaySource();
    h.credentialError = new CpRelayVaultUnresolvedError(1);
    expect(await run()).toMatchObject({ ok: false });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.updates[0]).toMatchObject({ status: "error" });
    expect(String(h.updates[0]!.errorMessage)).toContain("re-delivers");
  });

  it("no relay key at all marks the subscription errored and fetches nothing", async () => {
    relaySource();
    h.credential = null;
    expect(await run()).toMatchObject({ ok: false });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.updates[0]).toMatchObject({ status: "error" });
  });

  it("a non-relay source keeps its own resolved config and never reads the relay key", async () => {
    relaySource();
    h.sourceConfig.providerType = "http-api";
    h.credentialError = new Error("must not be read");
    expect(await run()).toMatchObject({ ok: true });
    expect(h.fetch.mock.calls[0]![0]).toMatchObject({ relayKey: "stale-key" });
  });
});
