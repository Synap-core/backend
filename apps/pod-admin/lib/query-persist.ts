/**
 * The console's query cache, kept in this browser (IndexedDB) across reloads,
 * so a page opened again draws what it drew last while it asks the pod again
 * (stale-while-revalidate), instead of a skeleton after every reload.
 *
 * Pattern of the desktop app's `browser/.../lib/queryPersister.ts` (TanStack
 * `dehydrate` / `hydrate` over native IndexedDB, no extra dependency). Rules:
 *
 *   - ONE stored cache, stamped with the signed-in identity id. Another
 *     identity never reads it: a mismatch discards it.
 *   - Only queries that succeeded, only tRPC queries, and never a path that
 *     names a secret or a security surface (`mayPersistQueryKey`).
 *   - Dropped after 24 h, and when a new build ships (`QUERY_CACHE_BUSTER`).
 *   - Written at most once a second while the cache changes.
 *   - Wiped on sign-out and when a 401 turns out to be a lost session
 *     (`clearPersistedQueryCache`).
 *   - A read that fails is logged and the console starts with an empty
 *     cache: nothing is made up to stand in for it.
 *
 * Data is stored as a SuperJSON string, the same transformer the tRPC client
 * reads the wire with, so a Date or a Map comes back as one.
 */

import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryClient,
} from "@tanstack/react-query";
import SuperJSON from "superjson";

/** Mirrors `QUERY_CACHE_DEFAULTS.persistMaxAge` of `@synap-core/sdk`. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60_000;
export const PERSIST_THROTTLE_MS = 1_000;

/**
 * Bump the leading version when the stored shape changes; the build id part
 * changes with every build (`next.config.ts` `env.POD_ADMIN_BUILD_ID`).
 */
export const QUERY_CACHE_BUSTER = `v1:${process.env.POD_ADMIN_BUILD_ID ?? "dev"}`;

/**
 * Words that keep a tRPC path out of the stored cache, matched anywhere in
 * the path, case-insensitive. Broad on purpose: a security read wrongly kept
 * off disk costs one network round trip; a secret wrongly kept on disk
 * outlives the session. `session` also keeps focus sessions (work data) off
 * disk; accepted. `config` keeps `sourceConfigs.list` off: a source's config
 * should hold vault references, but nothing stops a pasted credential there.
 */
const NEVER_PERSIST_PATH_WORDS = [
  "key",
  "secret",
  "token",
  "presence",
  "totp",
  "recovery",
  "oauth",
  "auth",
  "device",
  "credential",
  "vault",
  "password",
  "invite",
  "connection",
  "passkey",
  "session",
  "issuer",
  "config",
] as const;

/**
 * The tRPC path of a query key (`[["apiKeys", "list"], { input, type }]` →
 * `"apiKeys.list"`), or null for a key that is not a tRPC one.
 */
export function trpcPathOf(queryKey: readonly unknown[]): string | null {
  const first = queryKey[0];
  if (
    !Array.isArray(first) ||
    first.length === 0 ||
    !first.every((part) => typeof part === "string")
  ) {
    return null;
  }
  return first.join(".");
}

/**
 * THE predicate: may this query's data be written to this browser's disk?
 * Only tRPC keys: the console's own keys hold signed media URLs and pod
 * update state, read fresh each time.
 */
export function mayPersistQueryKey(queryKey: readonly unknown[]): boolean {
  const path = trpcPathOf(queryKey)?.toLowerCase();
  if (!path) return false;
  return !NEVER_PERSIST_PATH_WORDS.some((word) => path.includes(word));
}

export interface PersistedQueryCache {
  identityId: string;
  buster: string;
  persistedAt: number;
  /** `SuperJSON.stringify` of a `DehydratedState`. */
  state: string;
}

/** One slot: the cache of whoever is signed in on this browser. */
export interface QueryCacheStore {
  read(): Promise<unknown>;
  write(value: PersistedQueryCache): Promise<void>;
  clear(): Promise<void>;
}

export interface PersistScope {
  identityId: string;
  buster: string;
}

/** What `restoreQueryCache` found. Only `unreadable` means the store failed. */
export type RestoreOutcome = "restored" | "empty" | "discarded" | "unreadable";

/** What may leave memory: successful, persistable queries, no mutations. */
export function snapshotQueryCache(client: QueryClient): string {
  return SuperJSON.stringify(
    dehydrate(client, {
      shouldDehydrateQuery: (query) =>
        query.state.status === "success" && mayPersistQueryKey(query.queryKey),
      shouldDehydrateMutation: () => false,
    })
  );
}

export async function restoreQueryCache(
  client: QueryClient,
  store: QueryCacheStore,
  scope: PersistScope
): Promise<RestoreOutcome> {
  let raw: unknown;
  try {
    raw = await store.read();
  } catch (err) {
    console.warn(
      "[query-persist] Couldn't read the stored query cache; starting empty.",
      err
    );
    return "unreadable";
  }
  if (raw == null) return "empty";

  const saved = raw as Partial<PersistedQueryCache>;
  const usable =
    saved.identityId === scope.identityId &&
    saved.buster === scope.buster &&
    typeof saved.persistedAt === "number" &&
    Date.now() - saved.persistedAt <= PERSIST_MAX_AGE_MS &&
    typeof saved.state === "string";
  if (!usable) {
    await clearStore(store);
    return "discarded";
  }

  let state: DehydratedState;
  try {
    state = SuperJSON.parse<DehydratedState>(saved.state!);
  } catch (err) {
    console.warn("[query-persist] The stored query cache is corrupt.", err);
    await clearStore(store);
    return "discarded";
  }
  // Filtered again on the way in: a word added to the predicate since this
  // was written must not come back from disk.
  hydrate(client, {
    ...state,
    queries: state.queries.filter((q) => mayPersistQueryKey(q.queryKey)),
    mutations: [],
  });
  return "restored";
}

interface Writer {
  stop(): void;
  /** Resolves once a write already started has landed or failed. */
  settled(): Promise<void>;
}

const writers = new Set<Writer>();

/** Counts `clearPersistedQueryCache` calls: a restore that spans one must not start writing. */
let wipes = 0;

/**
 * Bring back what `store` kept for `scope`, THEN keep it up to date (writing
 * before the restore would replace it with an empty cache). Callers do not
 * wait: queries already in flight keep fetching, and the restored data shows
 * the moment the store answers. Returns the function that stops it.
 */
export function keepQueryCache(
  client: QueryClient,
  store: QueryCacheStore,
  scope: PersistScope
): () => void {
  const wipesAtStart = wipes;
  let stop: (() => void) | null = null;
  let ended = false;
  void restoreQueryCache(client, store, scope).then((outcome) => {
    // A store that cannot be read will not take writes either. A sign-out
    // while the restore ran wiped the store: nothing may write it again.
    if (ended || outcome === "unreadable" || wipes !== wipesAtStart) return;
    stop = persistQueryCache(client, store, scope);
  });
  return () => {
    ended = true;
    stop?.();
  };
}

/**
 * Write the cache to `store` at most once per `PERSIST_THROTTLE_MS` while it
 * changes. Returns the function that stops it.
 */
export function persistQueryCache(
  client: QueryClient,
  store: QueryCacheStore,
  scope: PersistScope
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const write = () => {
    timer = null;
    if (stopped) return;
    inFlight = (async () => {
      try {
        await store.write({
          identityId: scope.identityId,
          buster: scope.buster,
          persistedAt: Date.now(),
          state: snapshotQueryCache(client),
        });
      } catch (err) {
        console.warn("[query-persist] Couldn't store the query cache.", err);
      }
    })();
  };

  const unsubscribe = client.getQueryCache().subscribe((event) => {
    // New data, or a query gone: the only changes the stored copy cares about.
    const changed =
      (event.type === "updated" && event.action.type === "success") ||
      event.type === "removed";
    if (!changed || stopped || timer) return;
    timer = setTimeout(write, PERSIST_THROTTLE_MS);
  });

  const writer: Writer = {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribe();
      writers.delete(writer);
    },
    settled: () => inFlight,
  };
  writers.add(writer);
  return writer.stop;
}

/** How long sign-out waits for the wipe before it leaves anyway. */
const CLEAR_WAIT_MS = 1_500;

/**
 * Forget what this browser kept of the pod: stop every writer, let a write
 * already under way land, then empty the store. Called before leaving on
 * sign-out and when a 401 proves the session is gone. Bounded: a stuck
 * IndexedDB never holds sign-out (the next sign-in still discards another
 * identity's cache).
 */
export async function clearPersistedQueryCache(
  store: QueryCacheStore | null = indexedDbQueryCacheStore()
): Promise<void> {
  wipes += 1;
  const running = [...writers];
  for (const w of running) w.stop();
  if (!store) return;
  const wipe = (async () => {
    await Promise.all(running.map((w) => w.settled()));
    await clearStore(store);
  })();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    wipe,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, CLEAR_WAIT_MS);
    }),
  ]);
  clearTimeout(timeout);
}

async function clearStore(store: QueryCacheStore): Promise<void> {
  try {
    await store.clear();
  } catch (err) {
    console.warn("[query-persist] Couldn't clear the stored query cache.", err);
  }
}

// ─── IndexedDB ────────────────────────────────────────────────────────────

const DB_NAME = "pod-admin-query-cache";
const STORE_NAME = "cache";
const SLOT = "current";

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open is retried by the next call, not remembered.
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

function inStore<T>(
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = act(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () =>
          reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      })
  );
}

/**
 * The browser's store, or null where there is no IndexedDB (the server
 * render, a test): there, nothing was ever kept.
 */
export function indexedDbQueryCacheStore(): QueryCacheStore | null {
  if (typeof indexedDB === "undefined") return null;
  return {
    read: () => inStore("readonly", (s) => s.get(SLOT)),
    write: (value) =>
      inStore("readwrite", (s) => s.put(value, SLOT)).then(() => undefined),
    clear: () =>
      inStore("readwrite", (s) => s.delete(SLOT)).then(() => undefined),
  };
}
