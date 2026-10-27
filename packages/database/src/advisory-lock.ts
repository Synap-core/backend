/**
 * Run `fn` while holding a Postgres advisory lock on (hashtext(key1),
 * hashtext(key2)), taken AND released on ONE reserved connection.
 *
 * The one door for a session-level advisory lock in backend source (tripwire
 * `no-session-advisory-lock`). `sql` is a pool: a lock taken with one query and
 * released with another can land on two connections, the release is then a
 * no-op and the lock stays on an idle pooled connection forever. That happened
 * on 27 Oct 2026 (template-apply's per-proposal lock): every approve of a CRM
 * update waited on it, with no error, until the idle holder was ended. Pinning
 * both statements to `sql.reserve()` makes that impossible, and `fn` keeps
 * using the pool, so a long apply never holds a transaction open.
 *
 * If the unlock itself throws, the connection may still hold the lock, so it
 * is never released back to the pool. postgres.js gives a reserved connection
 * no destroy, so its backend is ended instead (`pg_terminate_backend`, from
 * the pool, which works even when that connection is wedged): Postgres drops a
 * session's locks when the session ends, and the driver moves the closed
 * connection out of the pool.
 */
import { sql } from "./client-pg.js";

export async function withAdvisoryLock<T>(
  key1: string,
  key2: string,
  fn: () => Promise<T>
): Promise<T> {
  const conn = await sql.reserve();
  /** The backend holding the lock; null once it is unlocked (or never taken). */
  let holder: number | null = null;
  try {
    const [row] = await conn<{ pid: number }[]>`
      SELECT pg_backend_pid() AS pid,
        pg_advisory_lock(hashtext(${key1}), hashtext(${key2}))`;
    holder = row!.pid;
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext(${key1}), hashtext(${key2}))`;
      holder = null;
    }
  } finally {
    if (holder === null) conn.release();
    else await sql`SELECT pg_terminate_backend(${holder})`;
  }
}
