/**
 * READ SNAPSHOT — a read-through cache over a Drizzle handle, for ONE read
 * that asks the governance resolver the same questions many times (the
 * agent × work matrix, `governance.matrix`).
 *
 * Why not a second resolver: the matrix must show what the REAL write would
 * do. Feeding the unchanged resolver (`dryRunAgentGovernanceDecision`) a
 * handle that memoizes identical SELECTs keeps ONE ladder — the rung order,
 * the scoring, the host step all stay where they are — and turns "agents ×
 * columns × probes" calls into roughly one query per distinct (agent, space)
 * instead of one per cell.
 *
 * Contract:
 *   - SELECTs only. A write (insert / update / delete / transaction / execute)
 *     THROWS: a snapshot that could write would not be a read.
 *   - Identical SQL + parameters ⇒ one round trip. A timestamp parameter is
 *     keyed RELATIVE to the snapshot's own clock, to the minute: every
 *     `expires_at > now()` and every "since 24 hours ago" in one read sees the
 *     same instant, which is what a snapshot means.
 *   - Lives for one request: never store it, never share it across users.
 */

const SNAPSHOT_CLOCK_STEP_MS = 60_000;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const WRITE_METHODS = new Set([
  "insert",
  "update",
  "delete",
  "transaction",
  "execute",
]);

interface SqlLike {
  toSQL: () => { sql: string; params: unknown[] };
  then: PromiseLike<unknown>["then"];
}

function isQuery(x: unknown): x is SqlLike {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as SqlLike).toSQL === "function" &&
    typeof (x as SqlLike).then === "function"
  );
}

export interface ReadSnapshotStats {
  /** Round trips actually made. */
  readonly queries: number;
  /** Answers served from the snapshot. */
  readonly hits: number;
}

export function createReadSnapshot<T extends object>(
  db: T
): { db: T; stats: () => ReadSnapshotStats } {
  const createdAt = Date.now();
  const cache = new Map<string, Promise<unknown>>();
  let queries = 0;
  let hits = 0;

  const keyOf = (q: SqlLike): string => {
    const { sql, params } = q.toSQL();
    return JSON.stringify([
      sql,
      params.map((p) => {
        // A timestamp reaches `toSQL()` as a Date or, already mapped by the
        // column, as an ISO string.
        const at =
          p instanceof Date
            ? p.getTime()
            : typeof p === "string" && ISO_INSTANT.test(p)
              ? Date.parse(p)
              : null;
        return at === null
          ? p
          : `<now${Math.round((at - createdAt) / SNAPSHOT_CLOCK_STEP_MS)}m>`;
      }),
    ]);
  };

  const wrap = (target: unknown, path: string): unknown => {
    if (
      !target ||
      (typeof target !== "object" && typeof target !== "function")
    ) {
      return target;
    }
    return new Proxy(target as object, {
      get(obj, prop) {
        if (prop === "then" && isQuery(obj)) {
          const key = keyOf(obj);
          let pending = cache.get(key);
          if (pending) hits += 1;
          else {
            queries += 1;
            pending = Promise.resolve(obj);
            cache.set(key, pending);
          }
          return (
            onFulfilled?: (v: unknown) => unknown,
            onRejected?: (e: unknown) => unknown
          ) => pending!.then(onFulfilled, onRejected);
        }
        if (
          typeof prop === "string" &&
          path === "" &&
          WRITE_METHODS.has(prop)
        ) {
          throw new Error(
            `read snapshot: "${prop}" is a write — a snapshot only reads`
          );
        }
        // Read against the real object (never the proxy): getters that touch
        // private class fields need their own `this`.
        const value = Reflect.get(obj, prop);
        if (typeof value === "function") {
          return (...args: unknown[]) =>
            wrap(value.apply(obj, args), `${path}.${String(prop)}`);
        }
        return typeof value === "object" && value !== null
          ? wrap(value, `${path}.${String(prop)}`)
          : value;
      },
    });
  };

  return {
    db: wrap(db, "") as T,
    stats: () => ({ queries, hits }),
  };
}
