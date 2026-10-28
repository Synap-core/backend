/**
 * `withAdvisoryLock` when the UNLOCK throws: the reserved connection may still
 * hold the lock, so it must never go back to the pool (a later caller would
 * get a connection that holds someone's lock, the 27 Oct defect again). Its
 * backend is ended instead. A fake pool records what the door did; the live
 * twin (advisory-lock.live.test.ts) shows the lock really drops on Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const log: string[] = [];
  let failUnlock = false;
  const text = (strings: TemplateStringsArray, values: unknown[]) =>
    strings.reduce(
      (acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ""),
      ""
    );
  const conn = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = text(strings, values);
      log.push(`conn: ${q.replace(/\s+/g, " ").trim()}`);
      if (q.includes("pg_advisory_unlock") && failUnlock)
        throw new Error("connection lost during unlock");
      return q.includes("pg_backend_pid") ? [{ pid: 4242 }] : [];
    }),
    { release: vi.fn(() => void log.push("release")) }
  );
  const pool = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      log.push(`pool: ${text(strings, values).replace(/\s+/g, " ").trim()}`);
      return [];
    }),
    { reserve: vi.fn(async () => conn) }
  );
  return {
    log,
    pool,
    conn,
    setFailUnlock: (v: boolean) => (failUnlock = v),
  };
});

vi.mock("../client-pg.js", () => ({ sql: h.pool }));

const { withAdvisoryLock } = await import("../advisory-lock.js");

beforeEach(() => {
  h.log.length = 0;
  h.setFailUnlock(false);
});

describe("withAdvisoryLock: what goes back to the pool", () => {
  it("releases the connection after a clean unlock", async () => {
    await expect(withAdvisoryLock("a", "b", async () => 7)).resolves.toBe(7);
    expect(h.log.at(-2)).toMatch(/^conn: SELECT pg_advisory_unlock/);
    expect(h.log.at(-1)).toBe("release");
    expect(h.log.some((l) => l.includes("pg_terminate_backend"))).toBe(false);
  });

  it("never releases a connection whose unlock threw: it ends that backend", async () => {
    h.setFailUnlock(true);
    await expect(withAdvisoryLock("a", "b", async () => 7)).rejects.toThrow(
      "connection lost during unlock"
    );
    expect(h.log).not.toContain("release");
    expect(h.log.at(-1)).toBe("pool: SELECT pg_terminate_backend(4242)");
  });

  it("does the same when fn threw first", async () => {
    h.setFailUnlock(true);
    await expect(
      withAdvisoryLock("a", "b", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("connection lost during unlock");
    expect(h.log).not.toContain("release");
    expect(h.log.at(-1)).toBe("pool: SELECT pg_terminate_backend(4242)");
  });

  it("releases a connection whose lock was never taken", async () => {
    h.conn.mockRejectedValueOnce(new Error("lock wait cancelled"));
    await expect(withAdvisoryLock("a", "b", async () => 7)).rejects.toThrow(
      "lock wait cancelled"
    );
    expect(h.log.at(-1)).toBe("release");
  });
});
