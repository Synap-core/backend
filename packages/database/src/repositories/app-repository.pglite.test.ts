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
import { AppNameTakenError, AppRepository } from "./app-repository.js";
import { GrantRepository } from "./grant-repository.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string) =>
  readFileSync(resolve(HERE, `../../migrations/${name}`), "utf8");
const GRANTS = read("0305_grants.sql");
const ROLES = read("0307_grant_roles.sql"); // grants.role_id — written by attach
const APPS = read("0309_apps.sql");
const APPS_REMOVED = read("0312_apps_removed_at.sql");

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
    last_used_at  timestamptz,
    -- keysFor reads these; the real table is far wider and not needed here.
    key_name      text NOT NULL DEFAULT 'Key',
    key_prefix    text NOT NULL DEFAULT 'synap_hub_live_',
    key_hash      text NOT NULL DEFAULT 'hash',
    usage_count   bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz
  );`);
  await pg.exec(GRANTS);
  await pg.exec(ROLES);
  await pg.exec(APPS);
  await pg.exec(APPS_REMOVED);
  // The pending projection reads only these `proposals` columns.
  await pg.exec(`CREATE TABLE proposals (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type  text NOT NULL,
    target_id    text NOT NULL,
    proposal_type text NOT NULL,
    status       text NOT NULL DEFAULT 'pending',
    data         jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
  );`);
  const db = drizzle(pg, { schema });
  repo = new AppRepository(db as never);
  grants = new GrantRepository(db as never);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(
    "DELETE FROM grants; DELETE FROM apps; DELETE FROM api_keys; DELETE FROM proposals;"
  );
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

  it("does NOT clear what a re-register did not mention — the silent-wipe guard", async () => {
    // Registering is idempotent by name and the add form re-adds a name the
    // person already has ("Adding a name you already use opens that app"). If
    // the upsert wrote `description ?? null`, that harmless-looking action would
    // BLANK the description written the first time, and reset mode/metadata.
    const first = await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
      description: "the landing page",
      metadata: { source: "cli" },
    });
    const second = await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
    });

    expect(second.id).toBe(first.id);
    expect(second.description).toBe("the landing page");
    expect(second.metadata).toEqual({ source: "cli" });
  });

  it("still writes a field the caller DID send, including an explicit null", async () => {
    // The other half of the rule. Without this, "preserve on omission" is
    // indistinguishable from a repository that ignores every later update.
    await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
      description: "the landing page",
    });
    const changed = await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
      description: "rewritten",
    });
    expect(changed.description).toBe("rewritten");

    const cleared = await repo.register({
      ownerUserId: OWNER,
      name: "synap.live",
      description: null,
    });
    expect(cleared.description).toBeNull();
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

describe("GrantRepository.resolveForKey — carries the app identity (Attribution)", () => {
  it("returns clientId so a key-auth door can attribute the write to its app", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
    await seedKey(KEY_A);
    await attachGrant(KEY_A, app.publicId);

    const grant = await grants.resolveForKey(KEY_A);
    expect(grant?.clientId).toBe(app.publicId);
  });

  it("returns clientId null for a bare key with no app", async () => {
    await seedKey(KEY_B);
    await attachGrant(KEY_B, null);
    const grant = await grants.resolveForKey(KEY_B);
    expect(grant?.clientId ?? null).toBeNull();
  });

  it("keeps clientId on a revoked grant (deny-all) — attribution is not an enforcement input", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
    await seedKey(KEY_A);
    await attachGrant(KEY_A, app.publicId);
    await grants.revokeForKeys([KEY_A], OWNER);

    const grant = await grants.resolveForKey(KEY_A);
    expect(grant?.scopes).toEqual([{ permissions: [] }]); // deny-all
    expect(grant?.clientId).toBe(app.publicId);
  });
});

/**
 * `keysFor` — the app's keys as its own page shows them: what each is called,
 * its scheme, when it was made, when it was last used and how often.
 *
 * The security property is the point of this block, and it is asserted
 * BEHAVIOURALLY: a sentinel is written into `api_keys.key_hash`, and the whole
 * returned payload must not contain it. That catches any future field that
 * carries the hash — a "shape" assertion on today's field names would not.
 */
describe("AppRepository.keysFor — the app's keys, and never the secret", () => {
  const SECRET_SENTINEL = "SENTINEL-bcrypt-hash-do-not-return";

  async function seedNamedKey(
    id: string,
    over: Partial<{
      name: string;
      prefix: string;
      revoked: boolean;
      madeAt: string;
      usedAt: string | null;
      uses: number;
    }> = {}
  ): Promise<void> {
    await pg.query(
      `INSERT INTO api_keys
         (id, is_active, key_name, key_prefix, key_hash, usage_count, created_at, last_used_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        !over.revoked,
        over.name ?? "Key",
        over.prefix ?? "synap_hub_live_",
        SECRET_SENTINEL,
        over.uses ?? 0,
        over.madeAt ?? "2026-10-01T00:00:00Z",
        over.usedAt ?? null,
        over.revoked ? "2026-10-02T00:00:00Z" : null,
      ]
    );
  }

  it("lists only the keys whose grant carries THIS app's public_id", async () => {
    const mine = await repo.register({ ownerUserId: OWNER, name: "intake" });
    const theirs = await repo.register({ ownerUserId: OWNER, name: "other" });
    await seedNamedKey(KEY_A);
    await seedNamedKey(KEY_B);
    await attachGrant(KEY_A, mine.publicId);
    await attachGrant(KEY_B, theirs.publicId);

    const keys = await repo.keysFor(mine.publicId);
    expect(keys.map((k) => k.id)).toEqual([KEY_A]);
  });

  it("NEVER returns the secret — the hash is not in the payload at all", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "intake" });
    await seedNamedKey(KEY_A, { name: "Vercel production", uses: 42 });
    await attachGrant(KEY_A, app.publicId);

    const keys = await repo.keysFor(app.publicId);
    // Non-vacuity: there IS a row to leak from.
    expect(keys).toHaveLength(1);
    expect(JSON.stringify(keys)).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(keys)).not.toContain("hash");
  });

  it("carries what a person needs and nothing else", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "intake" });
    await seedNamedKey(KEY_A, {
      name: "Vercel production",
      prefix: "synap_hub_live_",
      uses: 42,
      usedAt: "2026-10-05T09:30:00Z",
    });
    await attachGrant(KEY_A, app.publicId);

    const [key] = await repo.keysFor(app.publicId);
    expect(key).toMatchObject({
      id: KEY_A,
      keyName: "Vercel production",
      keyPrefix: "synap_hub_live_",
      usageCount: 42,
      isActive: true,
      revokedAt: null,
    });
    expect(key!.lastUsedAt?.toISOString()).toBe("2026-10-05T09:30:00.000Z");
  });

  it("still lists a REVOKED key — 'this app had a key' is a fact about the app", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "intake" });
    await seedNamedKey(KEY_A, { revoked: true });
    await attachGrant(KEY_A, app.publicId);

    const keys = await repo.keysFor(app.publicId);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.isActive).toBe(false);
    expect(keys[0]!.revokedAt).not.toBeNull();
  });

  it("is empty for an app with no key, and for an unknown id", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "intake" });
    expect(await repo.keysFor(app.publicId)).toEqual([]);
    expect(
      await repo.keysFor("app_00000000-0000-4000-8000-000000000000")
    ).toEqual([]);
  });

  it("orders newest first — the key you just minted is the one you are looking for", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "intake" });
    await seedNamedKey(KEY_A, { madeAt: "2026-09-01T00:00:00Z" });
    await seedNamedKey(KEY_B, { madeAt: "2026-10-01T00:00:00Z" });
    await attachGrant(KEY_A, app.publicId);
    await attachGrant(KEY_B, app.publicId);

    expect((await repo.keysFor(app.publicId)).map((k) => k.id)).toEqual([
      KEY_B,
      KEY_A,
    ]);
  });
});

/** File an `app/connect` proposal row the way `createPendingProposal` stores it. */
async function fileConnect(
  appId: string,
  requests: Array<{ permission: string; workspaceId: string }>,
  opts: { status?: string; at?: string } = {}
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `INSERT INTO proposals (target_type, target_id, proposal_type, status, data, created_at)
     VALUES ('app', $1, 'connect', $2, $3, $4) RETURNING id`,
    [
      appId,
      opts.status ?? "pending",
      JSON.stringify({ appId, requests }),
      opts.at ?? new Date().toISOString(),
    ]
  );
  return rows[0]!.id;
}

const WS_SALES = "55555555-0000-4000-8000-000000000005";
const WS_FIN = "66666666-0000-4000-8000-000000000006";

describe("AppRepository — the pending request projection", () => {
  it("carries the LATEST still-pending app/connect request, never a decided one", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
    await fileConnect(
      app.id,
      [{ permission: "entity.note.read", workspaceId: WS_FIN }],
      {
        status: "approved",
        at: "2026-10-07T12:00:00Z",
      }
    );
    await fileConnect(
      app.id,
      [{ permission: "entity.person.read", workspaceId: WS_SALES }],
      {
        at: "2026-10-06T09:00:00Z",
      }
    );
    const newest = await fileConnect(
      app.id,
      [{ permission: "entity.person.create", workspaceId: WS_SALES }],
      { at: "2026-10-06T10:00:00Z" }
    );

    const found = await repo.getByPublicId(app.publicId);
    expect(found!.pendingRequest).toEqual({
      proposalId: newest,
      requests: [{ permission: "entity.person.create", workspaceId: WS_SALES }],
      requestedAt: new Date("2026-10-06T10:00:00Z"),
    });
  });

  it("is null when nothing is waiting, and is projected per app in the list", async () => {
    const asking = await repo.register({ ownerUserId: OWNER, name: "asking" });
    const quiet = await repo.register({ ownerUserId: OWNER, name: "quiet" });
    const pid = await fileConnect(asking.id, [
      { permission: "entity.person.create", workspaceId: WS_SALES },
    ]);

    const byName = new Map(
      (await repo.listForOwner(OWNER)).map((r) => [
        r.app.name,
        r.pendingRequest,
      ])
    );
    expect(byName.get("asking")?.proposalId).toBe(pid);
    expect(byName.get("quiet")).toBeNull();
    expect(quiet.id).not.toBe(asking.id);
  });
});

describe("AppRepository.rename", () => {
  it("renames, and refuses a name the owner already uses with a typed conflict", async () => {
    const a = await repo.register({ ownerUserId: OWNER, name: "landing" });
    await repo.register({ ownerUserId: OWNER, name: "intake" });

    expect((await repo.rename(a.id, "  synap.live "))!.name).toBe("synap.live");
    await expect(repo.rename(a.id, "intake")).rejects.toBeInstanceOf(
      AppNameTakenError
    );
    // Another owner's name is not a conflict.
    await repo.register({ ownerUserId: OTHER_OWNER, name: "theirs" });
    expect((await repo.rename(a.id, "theirs"))!.name).toBe("theirs");
  });
});

describe("AppRepository.remove — 'Remove for good'", () => {
  it("hides the app from every listing but keeps it readable by id", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "old" });
    await repo.revoke(app.id);
    expect(
      (await repo.listForOwner(OWNER, { includeRevoked: true })).map(
        (r) => r.app.id
      )
    ).toEqual([app.id]);

    await repo.remove(app.id);

    expect(await repo.listForOwner(OWNER, { includeRevoked: true })).toEqual(
      []
    );
    expect(
      (await repo.getByPublicId(app.publicId))!.app.removedAt
    ).not.toBeNull();
  });

  it("re-registering the name revives the removed app (same public_id)", async () => {
    const app = await repo.register({ ownerUserId: OWNER, name: "old" });
    await repo.revoke(app.id);
    await repo.remove(app.id);

    const again = await repo.register({ ownerUserId: OWNER, name: "old" });
    expect(again.publicId).toBe(app.publicId);
    expect(again.removedAt).toBeNull();
    expect(again.revokedAt).toBeNull();
  });
});
