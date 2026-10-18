/**
 * Sync of a source a pod admin added, against a LOCAL fixture source (real
 * ed25519 signatures, an injected fetch that records every request). Proves:
 *   - a verified index replaces exactly that source's rows (upsert + prune by
 *     source), with the signed listing facts and no definition body;
 *   - the pod sends nothing that identifies it — no cookie, no Authorization,
 *     no key, refuses redirects — and fetches nothing off the source's origin;
 *   - a key change, a bad signature, an expired index, an older copy than
 *     the last accepted one and an outage leave the last verified rows alone;
 *     a key change stays a block until re-approval;
 *   - a sync racing a remove (or a key re-approval) writes no rows and no
 *     status — the source is re-read inside the write transaction.
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
  // The admin's source list as the write transaction reads it (share lock).
  const pod = { sources: [] as unknown[], keep: false };
  const settingsRead = {
    from: () => settingsRead,
    orderBy: () => settingsRead,
    limit: () => settingsRead,
    for: vi.fn(async (_mode: string) => [
      { settings: { marketplaceSources: pod.sources } },
    ]),
  };
  const tx = {
    select: vi.fn(() => settingsRead),
    insert: vi.fn(() => ({ values })),
    delete: vi.fn(() => ({ where })),
  };
  return {
    onConflict,
    values,
    where,
    tx,
    pod,
    settingsRead,
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
  podSettings: { settings: "settings", createdAt: "created_at" },
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  listingRows,
  syncThirdPartySource as runSync,
} from "../marketplace-source-sync.js";
import type { CatalogSource } from "../cp-catalog-sync.js";
import {
  anonymousGetInit,
  fetchDefinitionBytes,
  fetchSourceIndex,
  indexUrlFor,
  isNonPublicAddress,
  publicOnlyFetch,
  publicOnlyLookup,
  resolveDefinitionUrl,
} from "../marketplace-source-fetch.js";
import { keyFingerprint } from "../marketplace-source-verify.js";

const NOW = new Date("2026-10-13T12:00:00Z");

/** Sync a source that is (unless a test says otherwise) still on the pod. */
const syncThirdPartySource: typeof runSync = (src, previous, deps) => {
  if (!m.pod.keep) m.pod.sources = [src];
  return runSync(src, previous, deps);
};

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
    m.tx.select,
    m.settingsRead.for,
    m.record,
  ]) {
    fn.mockClear();
  }
  m.pod.keep = false;
  m.pod.sources = [];
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

describe("syncThirdPartySource — racing a remove or a key re-approval", () => {
  it("a source removed while it synced: no rows, no status — checked under a share lock", async () => {
    const key = makeKey();
    const fx = makeSource({ key, packages: PACKAGES });
    m.pod.keep = true;
    m.pod.sources = [];
    await runSync(source(key), undefined, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });
    expect(m.settingsRead.for).toHaveBeenCalledWith("share");
    expect(m.tx.insert).not.toHaveBeenCalled();
    expect(m.tx.delete).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it("a source re-keyed while it synced under the old key: nothing written", async () => {
    const key = makeKey();
    const fx = makeSource({ key, packages: PACKAGES });
    m.pod.keep = true;
    m.pod.sources = [{ ...source(key), publicKey: makeKey().publicKey }];
    await runSync(source(key), undefined, {
      fetchImpl: fx.fetchImpl,
      now: NOW,
    });
    expect(m.tx.insert).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });
});

describe("syncThirdPartySource — an older copy of the index", () => {
  it("is refused when the pod already accepted a newer one; the rows stay", async () => {
    const key = makeKey();
    const fx = makeSource({
      key,
      packages: PACKAGES,
      expires: "2026-10-20T00:00:00Z",
    });
    const status = await syncThirdPartySource(
      source(key),
      {
        state: "ok",
        lastSyncAt: "2026-10-13T11:50:00Z",
        lastOkAt: "2026-10-13T11:50:00Z",
        packageCount: 2,
        validUntil: "2026-11-01T00:00:00Z",
        message: null,
      },
      { fetchImpl: fx.fetchImpl, now: NOW }
    );
    expect(status).toMatchObject({
      state: "invalid",
      validUntil: "2026-11-01T00:00:00Z",
      packageCount: 2,
    });
    expect(m.tx.insert).not.toHaveBeenCalled();
  });
});

describe("only public addresses (SSRF)", () => {
  it("classifies every internal range as non-public", () => {
    for (const address of [
      "127.0.0.1",
      "127.8.9.10",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "0.1.2.3",
      "::",
      "::1",
      "[::1]",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1%eth0",
      "::ffff:127.0.0.1",
      "::ffff:a9fe:a9fe",
      "not-an-address",
    ]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
  });

  it("lets public addresses through", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.0.1",
      "172.32.0.1",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
    ]) {
      expect(isNonPublicAddress(address), address).toBe(false);
    }
  });

  it("the connect-time lookup refuses a name that resolves to an internal address", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      publicOnlyLookup("localhost", { all: true }, (e) => resolve(e))
    );
    expect(err?.code).toBe("ENOTPUBLIC");
  });

  it("a NAME that resolves to loopback (real DNS for `localhost`) is refused before any socket opens", async () => {
    const { createServer } = await import("node:net");
    const { request } = await import("node:https");
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    try {
      await expect(
        publicOnlyFetch(
          `https://localhost:${port}/synap-index.json`,
          anonymousGetInit()
        )
      ).rejects.toMatchObject({ code: "ENOTPUBLIC" });
      expect(connections).toBe(0);
      // Control: the same address with the default lookup does connect, so
      // the zero above is the guard, not a server nobody could reach.
      await new Promise<void>((resolve) => {
        const req = request(`https://localhost:${port}/`, () => resolve());
        req.on("error", () => resolve());
        req.end();
      });
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("the default fetch refuses an internal IP literal before connecting", async () => {
    for (const url of [
      "https://127.0.0.1/synap-index.json",
      "https://[::1]/synap-index.json",
      "https://169.254.169.254/latest",
    ]) {
      await expect(publicOnlyFetch(url, anonymousGetInit())).rejects.toThrow(
        /not a public address/
      );
    }
    // …and every source fetch uses it unless a test injects its own.
    expect(await fetchSourceIndex("https://127.0.0.1")).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
    expect(
      await fetchDefinitionBytes("https://10.0.0.1/defs/crm.json", 1024)
    ).toMatchObject({ ok: false });
  });
});
