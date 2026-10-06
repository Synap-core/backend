/**
 * REAL-POSTGRES (PGlite) test for `grants`: the 0305 migration SQL runs as
 * written, so the migration and the repository are proven against each other.
 *
 * Pinned: a malformed pattern is never stored; one ACTIVE grant per key; a key
 * that never had a grant resolves to null (legacy), while a key whose grant was
 * replaced, expired or revoked never falls back to "no grant" (that would turn
 * a revocation into a widening) — it resolves to deny-all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../schema/index.js";
import { GrantRepository } from "./grant-repository.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../../migrations/0305_grants.sql"),
  "utf8"
);
const KEY = "11111111-1111-4111-8111-111111111111";
const OTHER_KEY = "22222222-2222-4222-8222-222222222222";

let pg: PGlite;
let repo: GrantRepository;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE api_keys (id uuid PRIMARY KEY);
    INSERT INTO api_keys (id) VALUES ('${KEY}'), ('${OTHER_KEY}');`);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
  repo = new GrantRepository(
    drizzle(pg, { schema }) as unknown as ConstructorParameters<
      typeof GrantRepository
    >[0]
  );
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM grants");
});

const attach = (over: Partial<Parameters<GrantRepository["attach"]>[0]> = {}) =>
  repo.attach({
    apiKeyId: KEY,
    principalUserId: "agent-1",
    onBehalfOf: "human-1",
    permissions: ["entity.knowledge.read"],
    expiresAt: null,
    createdBy: "human-1",
    ...over,
  });

describe("GrantRepository (0305, PGlite)", () => {
  it("refuses a malformed pattern and stores nothing", async () => {
    await expect(attach({ permissions: ["Entity..read"] })).rejects.toThrow();
    await expect(attach({ permissions: [] })).rejects.toThrow();
    const { rows } = await pg.query("SELECT count(*)::int AS n FROM grants");
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("a key that never had a grant resolves to null (legacy)", async () => {
    expect(await repo.resolveForKey(OTHER_KEY)).toBeNull();
  });

  it("resolves the active grant with its sets", async () => {
    await attach({ workspaceIds: ["33333333-3333-4333-8333-333333333333"] });
    expect(await repo.resolveForKey(KEY)).toMatchObject({
      permissions: ["entity.knowledge.read"],
      workspaceIds: ["33333333-3333-4333-8333-333333333333"],
      projectIds: null,
      entityIds: null,
    });
  });

  it("keeps ONE active grant per key: attach replaces", async () => {
    await attach();
    await attach({ permissions: ["document.read"] });
    expect((await repo.resolveForKey(KEY))?.permissions).toEqual([
      "document.read",
    ]);
    const { rows } = await pg.query(
      "SELECT count(*)::int AS n FROM grants WHERE revoked_at IS NULL"
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("an expired grant resolves to deny-all, never to 'no grant'", async () => {
    await attach({ expiresAt: new Date(Date.now() - 1000) });
    expect(await repo.resolveForKey(KEY)).toMatchObject({ permissions: [] });
  });

  it("a revoked grant resolves to deny-all", async () => {
    await attach();
    await pg.exec(`UPDATE grants SET revoked_at = now()`);
    expect(await repo.resolveForKey(KEY)).toMatchObject({ permissions: [] });
  });
});
