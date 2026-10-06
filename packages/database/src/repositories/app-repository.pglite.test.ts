/**
 * REAL-POSTGRES (PGlite) test for `AppRepository` (App Connect v1) — the ONE
 * write door for `apps`. Drives the REAL repository against the REAL hand-written
 * migration SQL (0309 apps, 0305 grants + 0307 role_id), so register/read and
 * the schema are proven against each other rather than against a mock.
 *
 * The route test (`api routers/hub-protocol/rest/__tests__/apps.test.ts`) MOCKS
 * this repository and so exercises the ROUTE, not the repository; this file is
 * where the repository itself is exercised.
 *
 * Pinned: register is idempotent by owner+name (one row, one public_id) and
 * REVIVES a revoked app in place; the read join finds a grant only by
 * `client_id = public_id` AND an un-revoked grant AND an ACTIVE key; keyIdsFor
 * returns the app's distinct key ids.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../schema/index.js";
import { AppRepository } from "./app-repository.js";
import { GrantRepository } from "./grant-repository.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string) =>
  readFileSync(resolve(HERE, `../../migrations/${name}`), "utf8");
const GRANTS = read("0305_grants.sql");
const ROLES = read("0307_grant_roles.sql"); // grants.role_id — written by attach
const APPS = read("0309_apps.sql");

const OWNER = "owner-1";
const OTHER_OWNER = "owner-2";
const KEY_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const KEY_B = "bbbbbbbb-0000-4000-8000-00000000000b";

let pg: PGlite;
let repo: AppRepository;
let grants: GrantRepository;

beforeAll(async () => {
  pg = new PGlite();
  // The AppRepository reads only these three api_keys columns (is_active gate,
  // last_used_at fallback); the real table is far wider and not needed here.
  await pg.exec(`CREATE TABLE api_keys (
    id            uuid PRIMARY KEY,
    is_active     boolean NOT NULL DEFAULT true,
    last_used_at  timestamptz
  );`);
  await pg.exec(GRANTS);
  await pg.exec(ROLES);
  await pg.exec(APPS);
  const db = drizzle(pg, { schema });
  repo = new AppRepository(db as never);
  grants = new GrantRepository(db as never);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM grants; DELETE FROM apps; DELETE FROM api_keys;");
});

async function seedKey(id: string, active = true): Promise<void> {
  await pg.query("INSERT INTO api_keys (id, is_active) VALUES ($1, $2)", [
    id,
    active,
  ]);
}

/** Attach a grant for a key through the ONE write door. */
async function attachGrant(
  apiKeyId: string,
  clientId: string | null,
  permissions = ["entity.person.create"]
) {
  return grants.attach({
    apiKeyId,
    principalUserId: OWNER,
    onBehalfOf: OWNER,
    permissions,
    expiresAt: null,
    clientId,
    createdBy: OWNER,
  });
}

describe("AppRepository.register — idempotent by owner+name", () => {
  it("mints ONE app per owner+name and keeps its id and public_id across upserts", async () => {
    const first = await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
    });
    const second = await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
      description: "the landing page",
    });

    expect(second.id).toBe(first.id);
    expect(second.publicId).toBe(first.publicId);
    expect(second.description).toBe("the landing page");
    const { rows } = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM apps"
    );
    expect(rows).toEqual([{ n: 1 }]);
    expect(first.publicId).toMatch(/^app_[0-9a-f-]{36}$/);
  });

  it("scopes idempotency to the owner — another owner gets its own app", async () => {
    const mine = await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
    });
    const theirs = await repo.register({
      ownerUserId: OTHER_OWNER,
      name: "synap.live",
    });
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.publicId).not.toBe(mine.publicId);
  });

  it("REVIVES a revoked app in place (clears revoked_at, same id + public_id)", async () => {
    const first = await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
    });
    await repo.revoke(first.id);
    expect((await repo.get(first.id))!.revokedAt).not.toBeNull();

    const revived = await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
    });

    expect(revived.id).toBe(first.id);
    expect(revived.publicId).toBe(first.publicId);
    expect(revived.revokedAt).toBeNull();
    const { rows } = await pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM apps"
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});

describe("AppRepository.getByPublicId — the client_id grant join", () => {
  it("returns the grants whose client_id is the app's public_id", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
    await seedKey(KEY_A);
    await attachGrant(KEY_A, app.publicId);

    const found = await repo.getByPublicId(app.publicId);

    expect(found).not.toBeNull();
    expect(found!.app.id).toBe(app.id);
    expect(found!.grants).toHaveLength(1);
    expect(found!.grants[0]).toMatchObject({
      clientId: app.publicId,
      permissions: ["entity.person.create"],
      revokedAt: null,
    });
  });

  it("filters a grant of another client out", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
    await seedKey(KEY_A);
    await attachGrant(KEY_A, "app_someone-else");

    const found = await repo.getByPublicId(app.publicId);
    expect(found!.grants).toHaveLength(0);
  });

  it("counts reach only from an ACTIVE key (a rotated-away key is not reach)", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
    await seedKey(KEY_A, /* active */ false);
    await attachGrant(KEY_A, app.publicId);

    const found = await repo.getByPublicId(app.publicId);
    expect(found!.grants).toHaveLength(0);
  });

  it("excludes a revoked grant", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
    await seedKey(KEY_A);
    await attachGrant(KEY_A, app.publicId);
    await grants.revokeForKeys([KEY_A], OWNER);

    const found = await repo.getByPublicId(app.publicId);
    expect(found!.grants).toHaveLength(0);
  });
});

describe("AppRepository.keyIdsFor", () => {
  it("returns the distinct key ids bound to the app's public_id", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
    await seedKey(KEY_A);
    await seedKey(KEY_B);
    await attachGrant(KEY_A, app.publicId);
    // A second grant for the same key (e.g. a rotation that re-attached) must
    // not duplicate the id.
    await attachGrant(KEY_A, app.publicId, ["entity.person.read"]);

    expect(await repo.keyIdsFor(app.publicId)).toEqual([KEY_A]);
  });

  it("is empty for an app with no grants", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
    expect(await repo.keyIdsFor(app.publicId)).toEqual([]);
  });
});
