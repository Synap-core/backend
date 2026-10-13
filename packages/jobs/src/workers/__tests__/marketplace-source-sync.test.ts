/**
 * Sync of a source a pod admin added, against a LOCAL fixture source (real
 * ed25519 signatures, an injected fetch that records every request). Proves:
 *   - a verified index replaces exactly that source's rows (upsert + prune by
 *     source), with the signed listing facts and no definition body;
 *   - the pod sends nothing that identifies it — no cookie, no Authorization,
 *     no key, refuses redirects — and fetches nothing off the source's origin;
 *   - a key change, a bad signature, an expired index and an outage leave the
 *     last verified rows alone; a key change stays a block until re-approval.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  FIXTURE_ORIGIN,
  makeKey,
  makeSource,
  type FixtureKey,
} from "./fixtures/marketplace-source.js";

const m = vi.hoisted(() => {
  const onConflict = vi.fn(async () => undefined);
  const values = vi.fn((_rows: unknown) => ({
    onConflictDoUpdate: onConflict,
  }));
  const where = vi.fn(async (_pred: unknown) => undefined);
  const tx = {
    insert: vi.fn(() => ({ values })),
    delete: vi.fn(() => ({ where })),
  };
  return {
    onConflict,
    values,
    where,
    tx,
    record: vi.fn(async (_id: string, _status: unknown) => undefined),
  };
});

vi.mock("@synap/database", () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(m.tx),
    delete: () => ({ where: m.where }),
  },
  drizzleSql: Object.assign(() => "sql", { raw: vi.fn() }),
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  notInArray: vi.fn((a: unknown, b: unknown) => ({ notIn: [a, b] })),
  recordMarketplaceSourceStatus: m.record,
}));
vi.mock("@synap/database/schema", () => ({
  cpCatalogCache: { source: "source", kind: "kind", slug: "slug" },
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  listingRows,
  syncThirdPartySource,
} from "../marketplace-source-sync.js";
import type { CatalogSource } from "../cp-catalog-sync.js";
import {
  anonymousGetInit,
  fetchSourceIndex,
  indexUrlFor,
  resolveDefinitionUrl,
} from "../marketplace-source-fetch.js";
import { keyFingerprint } from "../marketplace-source-verify.js";

const NOW = new Date("2026-10-13T12:00:00Z");

function source(
  key: FixtureKey | null,
  over: Partial<CatalogSource> = {}
): CatalogSource {
  return {
    id: "acme",
    cacheKey: "acme",
    url: FIXTURE_ORIGIN,
    name: "Acme Labs",
    trust: "trusted",
    official: false,
    enabled: true,
    lockedOff: false,
    publicKey: key?.publicKey ?? null,
    keyFingerprint: key ? keyFingerprint(key.publicKey) : null,
    agentsMayPropose: false,
    addedBy: "user-1",
    addedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const PACKAGES = [
  { slug: "crm", kind: "template", definition: { workspaceName: "CRM" } },
  {
    slug: "charts/bar",
    kind: "cell",
    definition: { key: "bar", code: "export default 1" },
  },
];

beforeEach(() => {
  for (const fn of [
    m.onConflict,
    m.values,
    m.where,
    m.tx.insert,
    m.tx.delete,
    m.record,
  ]) {
    fn.mockClear();
  }
});

function upserted(): Array<Record<string, unknown>> {
  return (m.values.mock.calls[0]?.[0] ?? []) as Array<Record<string, unknown>>;
}

describe("syncThirdPartySource — a verified index", () => {
  it("replaces the source's rows with the signed list, no definitions, and records ok", async () => {
    const key = makeKey();
    const fx = makeSource({ key, packages: PACKAGES });
    const status = await syncThirdPartySource(source(key), undefined, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });

    expect(status).toMatchObject({
      state: "ok",
      packageCount: 2,
      validUntil: "2026-11-01T00:00:00Z",
      lastOkAt: NOW.toISOString(),
      message: null,
    });
    const rows = upserted();
    expect(rows.map((r) => [r.source, r.kind, r.slug])).toEqual([
      ["acme", "template", "crm"],
      ["acme", "cell", "charts/bar"],
    ]);
    expect(rows[0]).toMatchObject({
      definition: null,
      contentHash: fx.sha256.crm,
      listing: {
        definitionUrl: `${FIXTURE_ORIGIN}/defs/crm.json`,
        sha256: fx.sha256.crm,
      },
    });
    // Prune is scoped to THIS source.
    expect(m.where).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(m.where.mock.calls[0]?.[0])).toContain('"acme"');
    expect(m.record).toHaveBeenCalledWith("acme", status);
  });

  it("sends nothing that identifies the pod, and refuses redirects", async () => {
    const key = makeKey();
    const fx = makeSource({ key, packages: PACKAGES });
    await syncThirdPartySource(source(key), undefined, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });
    expect(fx.requests.map((r) => r.url)).toEqual([
      `${FIXTURE_ORIGIN}/synap-index.json`,
      `${FIXTURE_ORIGIN}/synap-index.json.sig`,
    ]);
    for (const { init } of fx.requests) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(Object.keys(init?.headers ?? {})).toEqual(["accept"]);
    }
  });

  it("leaves out a package whose definition lives on another origin", async () => {
    const key = makeKey();
    const fx = makeSource({
      key,
      packages: [
        PACKAGES[0]!,
        {
          slug: "evil",
          kind: "template",
          definition: {},
          definitionUrl: "https://internal.example/admin",
        },
      ],
    });
    const status = await syncThirdPartySource(source(key), undefined, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });
    expect(upserted().map((r) => r.slug)).toEqual(["crm"]);
    expect(status.packageCount).toBe(1);
    expect(status.message).toMatch(/evil/);
  });

  it("an empty signed index prunes every row of the source", async () => {
    const key = makeKey();
    const fx = makeSource({ key, packages: [] });
    await syncThirdPartySource(source(key), undefined, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });
    expect(m.values).not.toHaveBeenCalled();
    expect(m.where).toHaveBeenCalledTimes(1);
  });

  it("an unsigned showcase syncs its listing without a key", async () => {
    const fx = makeSource({ key: null, packages: PACKAGES });
    const status = await syncThirdPartySource(
      source(null, { trust: "showcase" }),
      undefined,
      {
        fetchImpl: fx.fetchImpl,
        now: NOW,
      }
    );
    expect(status.state).toBe("ok");
  });
});

describe("syncThirdPartySource — refusals keep the last verified copy", () => {
  const previous = {
    state: "ok" as const,
    lastSyncAt: "2026-10-13T11:50:00Z",
    lastOkAt: "2026-10-13T11:50:00Z",
    packageCount: 2,
    validUntil: "2026-11-01T00:00:00Z",
    message: null,
  };

  it("KEY CHANGE: blocks, records the new fingerprint, writes no rows", async () => {
    const pinned = makeKey();
    const attacker = makeKey();
    const fx = makeSource({ key: attacker, packages: PACKAGES });
    const status = await syncThirdPartySource(source(pinned), previous, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });
    expect(status).toMatchObject({
      state: "key_changed",
      pendingPublicKey: attacker.publicKey,
      pendingFingerprint: keyFingerprint(attacker.publicKey),
      packageCount: 2,
      validUntil: previous.validUntil,
    });
    expect(m.values).not.toHaveBeenCalled();
    expect(m.where).not.toHaveBeenCalled();
  });

  it("a key change stays a block through a later outage", async () => {
    const pinned = makeKey();
    const fx = makeSource({ key: pinned, packages: PACKAGES });
    fx.serve("/synap-index.json", null);
    const status = await syncThirdPartySource(
      source(pinned),
      {
        ...previous,
        state: "key_changed",
        pendingFingerprint: "ff",
        pendingPublicKey: "k",
        message: "changed",
      },
      { fetchImpl: fx.fetchImpl, now: NOW }
    );
    expect(status).toMatchObject({
      state: "key_changed",
      pendingFingerprint: "ff",
    });
  });

  it("the pinned key signing again clears a key change", async () => {
    const pinned = makeKey();
    const fx = makeSource({ key: pinned, packages: PACKAGES });
    const status = await syncThirdPartySource(
      source(pinned),
      { ...previous, state: "key_changed", pendingFingerprint: "ff" },
      { fetchImpl: fx.fetchImpl, now: NOW }
    );
    expect(status).toMatchObject({ state: "ok", pendingFingerprint: null });
  });

  it("a tampered index is a bad signature; nothing is written", async () => {
    const key = makeKey();
    const fx = makeSource({ key, packages: PACKAGES });
    fx.serve(
      "/synap-index.json",
      fx.indexBytes.toString().replace("Acme Labs", "Acme Labz")
    );
    const status = await syncThirdPartySource(source(key), previous, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });
    expect(status.state).toBe("bad_signature");
    expect(status.validUntil).toBe(previous.validUntil);
    expect(m.values).not.toHaveBeenCalled();
  });

  it("an expired index is refused", async () => {
    const key = makeKey();
    const fx = makeSource({
      key,
      packages: PACKAGES,
      expires: "2026-10-01T00:00:00Z",
    });
    const status = await syncThirdPartySource(source(key), previous, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });
    expect(status.state).toBe("expired");
    expect(m.values).not.toHaveBeenCalled();
  });

  it("an outage is `unreachable` and keeps the count", async () => {
    const key = makeKey();
    const status = await syncThirdPartySource(source(key), previous, {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      now: NOW,
    });
    expect(status).toMatchObject({ state: "unreachable", packageCount: 2 });
  });

  it("a trusted source with no pinned key is never synced", async () => {
    const fetchImpl = vi.fn();
    const status = await syncThirdPartySource(source(null), undefined, {
      fetchImpl,
      now: NOW,
    });
    expect(status.state).toBe("invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a renamed source id is refused", async () => {
    const key = makeKey();
    const fx = makeSource({ key, packages: PACKAGES, id: "acme-evil" });
    const status = await syncThirdPartySource(source(key), previous, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });
    expect(status.state).toBe("invalid");
  });
});

describe("fetch rules", () => {
  it("an address is https only; a non-.json address gets the index file name", () => {
    expect(indexUrlFor("https://acme.test")).toBe(
      "https://acme.test/synap-index.json"
    );
    expect(indexUrlFor("https://acme.test/market/")).toBe(
      "https://acme.test/market/synap-index.json"
    );
    expect(indexUrlFor("https://acme.test/feed/index.json?x=1")).toBe(
      "https://acme.test/feed/index.json"
    );
    expect(indexUrlFor("http://acme.test")).toBeNull();
    expect(indexUrlFor("https://user:pw@acme.test")).toBeNull();
    expect(indexUrlFor("file:///etc/passwd")).toBeNull();
  });

  it("a definition resolves only on the index's own https origin", () => {
    const idx = "https://acme.test/m/synap-index.json";
    expect(resolveDefinitionUrl(idx, "defs/a.json")).toBe(
      "https://acme.test/m/defs/a.json"
    );
    expect(resolveDefinitionUrl(idx, "/a.json")).toBe(
      "https://acme.test/a.json"
    );
    expect(
      resolveDefinitionUrl(idx, "https://cdn.acme.test/a.json")
    ).toBeNull();
    expect(resolveDefinitionUrl(idx, "http://acme.test/a.json")).toBeNull();
    expect(resolveDefinitionUrl(idx, "//169.254.169.254/latest")).toBeNull();
  });

  it("an oversized index is dropped mid-stream", async () => {
    const huge = new Uint8Array(3 * 1024 * 1024);
    const r = await fetchSourceIndex(
      "https://acme.test",
      async () => new Response(huge)
    );
    expect(r).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("a missing signature is reported as none (the verifier decides)", async () => {
    const r = await fetchSourceIndex("https://acme.test", async (url) =>
      url.endsWith(".sig")
        ? new Response("", { status: 404 })
        : new Response("{}")
    );
    expect(r).toMatchObject({ ok: true, signature: null });
  });

  it("the request init carries no credential of any kind", () => {
    const init = anonymousGetInit();
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
    });
    expect(init.headers).toEqual({ accept: "application/json" });
  });
});

describe("listingRows", () => {
  it("copies only signed facts and the resolved definition URL", () => {
    const { rows } = listingRows(
      "acme",
      "https://acme.test/synap-index.json",
      {
        schemaVersion: 1,
        source: { id: "acme", name: "Acme" },
        expires: "2026-11-01T00:00:00Z",
        packages: [
          {
            slug: "crm",
            kind: "template",
            version: "1.0.0",
            displayName: "CRM",
            definitionUrl: "crm.json",
            sha256: "a".repeat(64),
            homepageUrl: "https://acme.test/crm",
          },
        ],
      },
      NOW
    );
    expect(rows[0]).toMatchObject({
      source: "acme",
      vendor: null,
      listing: {
        definitionUrl: "https://acme.test/crm.json",
        homepageUrl: "https://acme.test/crm",
        installUrl: null,
      },
    });
  });
});
