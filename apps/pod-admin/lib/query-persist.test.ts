/**
 * The query cache kept across reloads: what may reach disk, whose it is, how
 * long it lives, how it is wiped, and that a failed read stays a failure.
 * Driven through a real QueryClient and real dehydrate/hydrate; only the
 * IndexedDB slot is an in-memory stand-in.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  PERSIST_MAX_AGE_MS,
  PERSIST_THROTTLE_MS,
  clearPersistedQueryCache,
  keepQueryCache,
  mayPersistQueryKey,
  persistQueryCache,
  restoreQueryCache,
  trpcPathOf,
  type PersistedQueryCache,
  type QueryCacheStore,
} from "./query-persist";

/** A tRPC v11 query key, as `@trpc/react-query` builds it. */
const key = (path: string, input?: unknown) => [
  path.split("."),
  { ...(input === undefined ? {} : { input }), type: "query" },
];

const SCOPE = { identityId: "u1", buster: "v1:build-a" };

function memoryStore(initial?: unknown) {
  let slot: unknown = initial;
  return {
    read: vi.fn(async () => slot),
    write: vi.fn(async (v: PersistedQueryCache) => {
      slot = v;
    }),
    clear: vi.fn(async () => {
      slot = undefined;
    }),
    peek: () => slot as PersistedQueryCache | undefined,
  } satisfies QueryCacheStore & { peek: () => unknown };
}

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mayPersistQueryKey: never a secret or a security read", () => {
  it.each([
    "apiKeys.list",
    "apiKeys.adminKeyDetail",
    "apiKeys.getOAuthConsentContext",
    "secretsVault.list",
    "secretsVault.hasVault",
    "focusSessions.provideSecretUse",
    "presence.factors",
    "presence.totp.get",
    "presence.recovery.status",
    "presence.passkeyChangeReady",
    "presence.devices.list",
    "presence.deviceLink.pending",
    "devices.list",
    "notifCenter.listDevices",
    "oauthClients.adminList",
    "workspaces.listInvites",
    "workspaces.previewInvite",
    "applicationConnections.list",
    "connectors.allConnections",
    "trustedIssuers.list",
    "focusSessions.get",
    "sourceConfigs.list",
  ])("keeps %s off disk", (path) => {
    expect(mayPersistQueryKey(key(path, { id: "x" }))).toBe(false);
  });

  it.each([
    "workspaces.list",
    "entities.adminList",
    "runs.list",
    "system.listAuditLogs",
    "users.me",
    "proposals.list",
    "governanceRules.matrix",
    "diagnose.global",
  ])("keeps %s", (path) => {
    expect(mayPersistQueryKey(key(path))).toBe(true);
  });

  it("matches whatever the case", () => {
    expect(mayPersistQueryKey([["SECRETSVAULT", "LIST"], {}])).toBe(false);
    expect(mayPersistQueryKey([["podHealth", "get"], {}])).toBe(true);
  });

  it("keeps the console's own (non-tRPC) keys off disk", () => {
    // Signed media URLs, pod update state, broker trust.
    expect(mayPersistQueryKey(["stored-media", "https://pod", "/f/1"])).toBe(
      false
    );
    expect(mayPersistQueryKey(["pod-updates"])).toBe(false);
    expect(mayPersistQueryKey(["pod-admin", "broker-trust"])).toBe(false);
  });

  it("denies every query this app makes to a security router", () => {
    // Derived from the source, so a new read on one of these routers joins
    // the check by existing.
    const root = fileURLToPath(new URL("../app", import.meta.url));
    const paths = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const src = readFileSync(full, "utf8");
          for (const m of src.matchAll(
            /trpc\.([A-Za-z]+(?:\.[A-Za-z]+)+)\.use(?:Suspense)?(?:Infinite)?Query\b/g
          )) {
            paths.add(m[1]!);
          }
        }
      }
    };
    walk(root);
    // Non-vacuous: the scan still sees the app's reads, a known one included.
    expect(paths.size).toBeGreaterThan(100);
    expect(paths).toContain("apiKeys.list");
    expect(paths).toContain("workspaces.list");

    const SECURITY_ROUTERS = [
      "apiKeys",
      "secretsVault",
      "presence",
      "oauthClients",
      "devices",
      "trustedIssuers",
      "applicationConnections",
    ];
    const security = [...paths].filter((p) =>
      SECURITY_ROUTERS.includes(p.split(".")[0]!)
    );
    expect(security.length).toBeGreaterThan(15);
    expect(security.filter((p) => mayPersistQueryKey(key(p)))).toEqual([]);
    // And the cache still keeps most of what the console reads.
    const kept = [...paths].filter((p) => mayPersistQueryKey(key(p)));
    expect(kept.length).toBeGreaterThan(paths.size / 2);
  });

  it("reads the path out of a tRPC key only", () => {
    expect(trpcPathOf(key("presence.totp.get"))).toBe("presence.totp.get");
    expect(trpcPathOf(["pod-updates"])).toBeNull();
    expect(trpcPathOf([])).toBeNull();
  });
});

describe("what is written", () => {
  it("keeps successful, allowed queries only, and restores them as they were", async () => {
    const source = client();
    const seenAt = new Date("2026-11-20T09:00:00Z");
    source.setQueryData(key("workspaces.list"), [{ id: "w1", seenAt }]);
    source.setQueryData(key("apiKeys.list"), [{ id: "k1", secret: "s" }]);
    await source.prefetchQuery({
      queryKey: key("runs.list"),
      queryFn: () => Promise.reject(new Error("pod said no")),
    });
    void source.prefetchQuery({
      queryKey: key("proposals.list"),
      queryFn: () => new Promise(() => {}),
    });

    const store = memoryStore();
    vi.useFakeTimers();
    const stop = persistQueryCache(source, store, SCOPE);
    source.setQueryData(key("users.me"), { id: "u1" });
    await vi.advanceTimersByTimeAsync(PERSIST_THROTTLE_MS);
    stop();
    vi.useRealTimers();

    const saved = store.peek()!;
    expect(saved.identityId).toBe("u1");
    expect(saved.buster).toBe("v1:build-a");
    expect(saved.state).not.toContain("k1");

    const target = client();
    expect(await restoreQueryCache(target, store, SCOPE)).toBe("restored");
    const restored = target.getQueryData<{ seenAt: Date }[]>(
      key("workspaces.list")
    );
    expect(restored?.[0]?.seenAt).toBeInstanceOf(Date);
    expect(restored?.[0]?.seenAt.getTime()).toBe(seenAt.getTime());
    expect(target.getQueryData(key("users.me"))).toEqual({ id: "u1" });
    expect(target.getQueryData(key("apiKeys.list"))).toBeUndefined();
    expect(target.getQueryState(key("runs.list"))).toBeUndefined();
    expect(target.getQueryState(key("proposals.list"))).toBeUndefined();
  });

  it("writes at most once per second while the cache changes", async () => {
    vi.useFakeTimers();
    const c = client();
    const store = memoryStore();
    const stop = persistQueryCache(c, store, SCOPE);
    for (let n = 0; n < 20; n++) c.setQueryData(key("runs.list"), { n });
    await vi.advanceTimersByTimeAsync(PERSIST_THROTTLE_MS - 1);
    expect(store.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(store.peek()!.state).toContain('"n":19');
    stop();
  });
});

describe("whose cache it is, and for how long", () => {
  async function savedBy(scope: typeof SCOPE, persistedAt = Date.now()) {
    const source = client();
    source.setQueryData(key("workspaces.list"), [{ id: "w1" }]);
    const store = memoryStore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = persistQueryCache(source, store, scope);
    source.setQueryData(key("users.me"), { id: scope.identityId });
    await vi.advanceTimersByTimeAsync(PERSIST_THROTTLE_MS);
    stop();
    vi.useRealTimers();
    return memoryStore({ ...store.peek()!, persistedAt });
  }

  it("never hands one identity another's cache, and drops it", async () => {
    const store = await savedBy({ identityId: "u2", buster: SCOPE.buster });
    const target = client();
    expect(await restoreQueryCache(target, store, SCOPE)).toBe("discarded");
    expect(target.getQueryData(key("workspaces.list"))).toBeUndefined();
    expect(store.clear).toHaveBeenCalled();
    expect(store.peek()).toBeUndefined();
  });

  it("drops a cache another build wrote", async () => {
    const store = await savedBy({ identityId: "u1", buster: "v1:build-old" });
    const target = client();
    expect(await restoreQueryCache(target, store, SCOPE)).toBe("discarded");
    expect(target.getQueryData(key("workspaces.list"))).toBeUndefined();
  });

  it("drops a cache older than 24 hours, keeps a younger one", async () => {
    const old = await savedBy(SCOPE, Date.now() - PERSIST_MAX_AGE_MS - 1_000);
    expect(await restoreQueryCache(client(), old, SCOPE)).toBe("discarded");
    const young = await savedBy(
      SCOPE,
      Date.now() - PERSIST_MAX_AGE_MS + 60_000
    );
    expect(await restoreQueryCache(client(), young, SCOPE)).toBe("restored");
  });

  it("filters a denied query that is already on disk", async () => {
    const source = client();
    source.setQueryData(key("secretsVault.list"), [{ id: "v" }]);
    source.setQueryData(key("workspaces.list"), [{ id: "w1" }]);
    // Written by an older, looser predicate.
    const { dehydrate } = await import("@tanstack/react-query");
    const SuperJSON = (await import("superjson")).default;
    const store = memoryStore({
      ...SCOPE,
      persistedAt: Date.now(),
      state: SuperJSON.stringify(dehydrate(source)),
    });
    const target = client();
    expect(await restoreQueryCache(target, store, SCOPE)).toBe("restored");
    expect(target.getQueryData(key("secretsVault.list"))).toBeUndefined();
    expect(target.getQueryData(key("workspaces.list"))).toEqual([{ id: "w1" }]);
  });
});

describe("a failed read is a failure, not data", () => {
  it("logs and starts empty when the store cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore();
    store.read.mockRejectedValueOnce(new Error("IndexedDB blocked"));
    const target = client();
    expect(await restoreQueryCache(target, store, SCOPE)).toBe("unreadable");
    expect(target.getQueryCache().getAll()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("drops a corrupt cache instead of hydrating it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore({
      ...SCOPE,
      persistedAt: Date.now(),
      state: "{",
    });
    const target = client();
    expect(await restoreQueryCache(target, store, SCOPE)).toBe("discarded");
    expect(target.getQueryCache().getAll()).toEqual([]);
    expect(store.peek()).toBeUndefined();
  });

  it("says empty when nothing was ever kept", async () => {
    expect(await restoreQueryCache(client(), memoryStore(), SCOPE)).toBe(
      "empty"
    );
  });
});

describe("sign-out wipes it", () => {
  it("stops writing and clears the store", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = client();
    const store = memoryStore();
    persistQueryCache(c, store, SCOPE);
    c.setQueryData(key("workspaces.list"), [{ id: "w1" }]);
    await vi.advanceTimersByTimeAsync(PERSIST_THROTTLE_MS);
    expect(store.peek()).toBeDefined();

    c.setQueryData(key("runs.list"), [{ id: "r1" }]); // a write is pending
    await clearPersistedQueryCache(store);
    expect(store.peek()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(PERSIST_THROTTLE_MS * 3);
    expect(store.peek()).toBeUndefined();
    expect(store.write).toHaveBeenCalledTimes(1);
  });
});

describe("restore, then keep", () => {
  /** Let the restore's promise chain run (setImmediate is not faked here). */
  const settle = () => new Promise((r) => setImmediate(r));

  /** A store whose first read waits until the test releases it. */
  function heldStore(initial?: unknown) {
    const store = memoryStore(initial);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const read = store.read.getMockImplementation()!;
    store.read.mockImplementationOnce(async () => {
      await held;
      return read();
    });
    return { store, release };
  }

  it("brings the kept cache back, then writes what changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const saved = memoryStore();
    const source = client();
    const stopSource = persistQueryCache(source, saved, SCOPE);
    source.setQueryData(key("workspaces.list"), [{ id: "w1" }]);
    await vi.advanceTimersByTimeAsync(PERSIST_THROTTLE_MS);
    stopSource();

    const c = client();
    const stop = keepQueryCache(c, saved, SCOPE);
    await settle();
    expect(c.getQueryData(key("workspaces.list"))).toEqual([{ id: "w1" }]);
    c.setQueryData(key("runs.list"), [{ id: "r1" }]);
    await vi.advanceTimersByTimeAsync(PERSIST_THROTTLE_MS);
    expect(saved.peek()!.state).toContain("r1");
    expect(saved.peek()!.state).toContain("w1");
    stop();
  });

  it("never writes again after a sign-out that landed during the restore", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, release } = heldStore();
    const c = client();
    keepQueryCache(c, store, SCOPE);
    await clearPersistedQueryCache(store); // sign-out, restore still reading
    release();
    await settle();
    c.setQueryData(key("workspaces.list"), [{ id: "w1" }]);
    await vi.advanceTimersByTimeAsync(PERSIST_THROTTLE_MS * 3);
    expect(store.write).not.toHaveBeenCalled();
    expect(store.peek()).toBeUndefined();
  });

  it("never writes to a store it could not read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore();
    store.read.mockRejectedValueOnce(new Error("IndexedDB blocked"));
    const c = client();
    keepQueryCache(c, store, SCOPE);
    await settle();
    c.setQueryData(key("workspaces.list"), [{ id: "w1" }]);
    await vi.advanceTimersByTimeAsync(PERSIST_THROTTLE_MS * 3);
    expect(store.write).not.toHaveBeenCalled();
  });
});
