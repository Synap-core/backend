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
 */
import { sql } from "./client-pg.js";

export async function withAdvisoryLock<T>(
  key1: string,
  key2: string,
  fn: () => Promise<T>
): Promise<T> {
  const conn = await sql.reserve();
  try {
    await conn`SELECT pg_advisory_lock(hashtext(${key1}), hashtext(${key2}))`;
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext(${key1}), hashtext(${key2}))`;
    }
  } finally {
    conn.release();
  }
}
