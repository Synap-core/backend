/**
 * REAL-POSTGRES (PGlite) test for `account_recovery_codes`: the 0294 migration
 * SQL is executed as written (no ddl generated from the Drizzle schema), so the
 * migration and the repository are proven against each other.
 *
 * Pinned: a claim is single-use, including under a concurrent double claim;
 * `release` only undoes the claim it made; a regenerate replaces the whole
 * batch (used codes included); `summary` / `anyUnused` count what is unused.
 *
 * `users` is the minimal slice the foreign key needs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../schema/index.js";
import { AccountRecoveryCodeRepository } from "./account-recovery-code-repository.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../../migrations/0294_account_recovery_codes.sql"),
  "utf8"
);

let pg: PGlite;
let repo: AccountRecoveryCodeRepository;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE users (id text PRIMARY KEY);
    INSERT INTO users (id) VALUES ('alice'), ('bob');`);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent (IF NOT EXISTS)
  repo = new AccountRecoveryCodeRepository(
    drizzle(pg, { schema }) as unknown as ConstructorParameters<
      typeof AccountRecoveryCodeRepository
    >[0]
  );
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM account_recovery_codes");
});

const BATCH_A = "11111111-1111-4111-8111-111111111111";
const BATCH_B = "22222222-2222-4222-8222-222222222222";

describe("AccountRecoveryCodeRepository (0294, PGlite)", () => {
  it("claims a code once; a second claim of the same code fails", async () => {
    await repo.replaceBatch("alice", BATCH_A, ["h1", "h2"], new Date());
    const first = (await repo.listUnused("alice")).find(
      (c) => c.codeHash === "h1"
    );
    expect(await repo.claim(first!.id, new Date())).toBe(true);
    expect(await repo.claim(first!.id, new Date())).toBe(false);
    expect((await repo.listUnused("alice")).map((c) => c.codeHash)).toEqual([
      "h2",
    ]);
  });

  it("concurrent double claim: exactly one wins", async () => {
    await repo.replaceBatch("alice", BATCH_A, ["h1"], new Date());
    const [only] = await repo.listUnused("alice");
    const results = await Promise.all([
      repo.claim(only!.id, new Date()),
      repo.claim(only!.id, new Date()),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("release undoes only the claim it made", async () => {
    await repo.replaceBatch("alice", BATCH_A, ["h1"], new Date());
    const [only] = await repo.listUnused("alice");
    const mine = new Date("2026-10-04T10:00:00.000Z");
    expect(await repo.claim(only!.id, mine)).toBe(true);
    await repo.release(only!.id, new Date("2026-10-04T11:00:00.000Z"));
    expect(await repo.listUnused("alice")).toHaveLength(0);
    await repo.release(only!.id, mine);
    expect(await repo.listUnused("alice")).toHaveLength(1);
  });

  it("replaceBatch drops the whole old batch, used codes included", async () => {
    await repo.replaceBatch("alice", BATCH_A, ["a1", "a2", "a3"], new Date());
    const [a1] = await repo.listUnused("alice");
    await repo.claim(a1!.id, new Date());
    await repo.replaceBatch("alice", BATCH_B, ["b1", "b2"], new Date());
    const rows = (
      await pg.query<{ batch_id: string }>(
        "SELECT batch_id FROM account_recovery_codes WHERE user_id = 'alice'"
      )
    ).rows;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.batch_id))).toEqual(new Set([BATCH_B]));
  });

  it("scopes by user and summarizes what is unused", async () => {
    const at = new Date("2026-10-04T09:00:00.000Z");
    await repo.replaceBatch("alice", BATCH_A, ["a1", "a2", "a3"], at);
    await repo.replaceBatch("bob", BATCH_B, ["b1"], at);
    const [a1] = await repo.listUnused("alice");
    await repo.claim(a1!.id, new Date());
    const s = await repo.summary("alice");
    expect(s).toEqual({ total: 3, remaining: 2, createdAt: at });
    expect(await repo.summary("nobody")).toEqual({
      total: 0,
      remaining: 0,
      createdAt: null,
    });
    expect((await repo.listUnused("bob")).map((c) => c.codeHash)).toEqual([
      "b1",
    ]);
  });

  it("anyUnused is false when every code is used, true otherwise", async () => {
    expect(await repo.anyUnused()).toBe(false);
    await repo.replaceBatch("alice", BATCH_A, ["a1"], new Date());
    expect(await repo.anyUnused()).toBe(true);
    const [a1] = await repo.listUnused("alice");
    await repo.claim(a1!.id, new Date());
    expect(await repo.anyUnused()).toBe(false);
  });

  it("deleting the user cascades to their codes", async () => {
    await repo.replaceBatch("bob", BATCH_B, ["b1"], new Date());
    await pg.exec("DELETE FROM users WHERE id = 'bob'");
    expect(await repo.listUnused("bob")).toHaveLength(0);
  });
});
