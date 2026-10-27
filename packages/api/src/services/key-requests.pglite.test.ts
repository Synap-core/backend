/**
 * Keys plan W2 — the KEY REQUEST door (Decision 4: the CLI requests, the
 * person validates on pod-admin, never a direct mint), driven through the REAL
 * service on PGlite: request → review → decide → collect ONCE → list → revoke.
 *
 * Stubbed: the db handle and the governance gate (a person deciding in their
 * own session is granted; the ladder is pinned elsewhere).
 *
 * Pinned (each rules out a rule):
 *  - the CLI's computer never mints: nothing exists in api_keys until the
 *    person approved AND the computer collected;
 *  - the key is collected exactly once, only by the requester, and minted as
 *    the PERSON with the approved (narrowed) grant and DERIVED scopes;
 *  - approving wider than the template is refused (permissions, uses, life);
 *  - another person cannot read or decide the request;
 *  - the computer lists and revokes only the keys it requested;
 *  - no column holds the request code or the key in clear.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
    // The key repository appends a spine event through postgres.js `sql`
    // (not the PGlite handle); the event is not under test here.
    EventRepository: class {
      async append() {
        return undefined;
      }
    },
  };
});

vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: vi.fn(async () => true),
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { GrantRepository } from "@synap/database";
import {
  collectKeyRequest,
  createKeyRequest,
  decideKeyRequest,
  getKeyRequest,
  listKeyTemplates,
  listRequestedKeys,
  revokeRequestedKey,
} from "./key-requests.js";

const PERSON = "kr-person";
const OTHER_PERSON = "kr-other";
const COMPUTER = "kr-computer";
const OTHER_COMPUTER = "kr-other-computer";
const ORIGIN = "https://pod-admin.example";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "usage_count"
        ? " default 0"
        : c.name === "created_at"
          ? " default now()"
          : c.name === "is_active"
            ? " default true"
            : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await h.client!.exec(`
    insert into users (id, name, user_type) values
      ('${PERSON}', 'Ada', 'human'),
      ('${OTHER_PERSON}', 'Bob', 'human'),
      ('${COMPUTER}', 'ada-laptop', 'agent'),
      ('${OTHER_COMPUTER}', 'bob-laptop', 'agent');
  `);
});

const request = (over: Partial<Parameters<typeof createKeyRequest>[0]> = {}) =>
  createKeyRequest({
    requesterUserId: COMPUTER,
    requesterKeyId: randomUUID(),
    personUserId: PERSON,
    templateId: "dev-loop-poster",
    podAdminOrigin: ORIGIN,
    ...over,
  });

/** Collect once the poll interval has passed (the door answers slow_down otherwise). */
async function collect(code: string, requester = COMPUTER) {
  await h.client!.query(
    `update key_requests set last_polled_at = null where request_code_hash is not null`
  );
  return collectKeyRequest({ requestCode: code, requesterUserId: requester });
}

const apiKeyCount = async () =>
  (await h.client!.query<{ n: number }>(`select count(*)::int n from api_keys`))
    .rows[0]!.n;

describe("a key request, end to end", () => {
  it("request → pending → approve → the key, once, as the person", async () => {
    const before = await apiKeyCount();
    const req = await request({ name: "devbox poster" });
    expect(req.review_url).toBe(`${ORIGIN}/keys/requests/${req.request_id}`);
    expect(req.interval).toBeGreaterThan(0);

    expect(await collect(req.request_code)).toEqual({
      ok: false,
      error: "authorization_pending",
    });
    // A poll inside the interval widens it.
    const fast = await collectKeyRequest({
      requestCode: req.request_code,
      requesterUserId: COMPUTER,
    });
    expect(fast).toMatchObject({ ok: false, error: "slow_down" });
    expect(await apiKeyCount()).toBe(before); // the computer minted nothing

    const view = await getKeyRequest({
      requestId: req.request_id,
      personUserId: PERSON,
    });
    expect(view).toMatchObject({
      status: "pending",
      requester: { userId: COMPUTER, name: "ada-laptop", isComputer: true },
      template: { id: "dev-loop-poster", name: "Dev loop poster" },
      draft: {
        name: "devbox poster",
        uses: ["hub"],
        grant: { permissions: ["event.create"], expiresInDays: 90 },
      },
    });

    await decideKeyRequest({
      requestId: req.request_id,
      personUserId: PERSON,
      decision: "approve",
    });
    expect(await apiKeyCount()).toBe(before); // approval mints nothing either

    const got = await collect(req.request_code);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.body).toMatchObject({
      name: "devbox poster",
      scopes: ["hub-protocol.read", "hub-protocol.write"],
    });
    expect(got.body.apiKey.startsWith(got.body.keyPrefix)).toBe(true);
    expect(await apiKeyCount()).toBe(before + 1);

    const { rows } = await h.client!.query<{
      user_id: string;
      scope: string[];
    }>(`select user_id, scope from api_keys where id = $1`, [got.body.keyId]);
    expect(rows[0]).toEqual({
      user_id: PERSON,
      scope: ["hub-protocol.read", "hub-protocol.write"],
    });
    const grant = await new GrantRepository(h.db as never).resolveForKey(
      got.body.keyId
    );
    expect(grant?.scopes).toMatchObject([{ permissions: ["event.create"] }]);

    // Once: the second collect gets nothing.
    expect(await collect(req.request_code)).toEqual({
      ok: false,
      error: "expired_token",
    });

    // No column holds the request code or the key in clear.
    const raw = JSON.stringify(
      (
        await h.client!.query(`select * from key_requests where id = $1`, [
          req.request_id,
        ])
      ).rows
    );
    expect(raw).not.toContain(req.request_code);
    expect(raw).not.toContain(got.body.apiKey);
  });

  it("the person may narrow it: the narrowed key is what is minted", async () => {
    const req = await request();
    const W = randomUUID();
    await decideKeyRequest({
      requestId: req.request_id,
      personUserId: PERSON,
      decision: "approve",
      draft: {
        name: "narrow poster",
        uses: ["hub"],
        grant: {
          permissions: ["event.create"],
          workspaceIds: [W],
          expiresInDays: 1,
        },
      },
    });
    const got = await collect(req.request_code);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.body.name).toBe("narrow poster");
    const grant = await new GrantRepository(h.db as never).resolveForKey(
      got.body.keyId
    );
    expect(grant?.scopes).toMatchObject([
      { permissions: ["event.create"], workspaceIds: [W] },
    ]);
    const exp = new Date(got.body.expiresAt!).getTime();
    expect(Math.abs(exp - (Date.now() + 86_400_000))).toBeLessThan(60_000);
  });

  it("approving wider than the template is refused, and the request stays pending", async () => {
    const req = await request();
    const wider = [
      { permissions: ["event.create", "entity.*.read"], expiresInDays: 90 },
      { permissions: ["event.create"], expiresInDays: null },
      { permissions: ["*"], expiresInDays: 30 },
    ];
    for (const grant of wider)
      await expect(
        decideKeyRequest({
          requestId: req.request_id,
          personUserId: PERSON,
          decision: "approve",
          draft: { name: "x", uses: ["hub"], grant },
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      decideKeyRequest({
        requestId: req.request_id,
        personUserId: PERSON,
        decision: "approve",
        draft: {
          name: "x",
          uses: ["hub", "mcp"],
          grant: { permissions: ["event.create"] },
        },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (await getKeyRequest({ requestId: req.request_id, personUserId: PERSON }))
        .status
    ).toBe("pending");
  });

  it("a denied request answers access_denied and mints nothing", async () => {
    const before = await apiKeyCount();
    const req = await request();
    await decideKeyRequest({
      requestId: req.request_id,
      personUserId: PERSON,
      decision: "deny",
    });
    expect(await collect(req.request_code)).toEqual({
      ok: false,
      error: "access_denied",
    });
    expect(await apiKeyCount()).toBe(before);
  });
});

describe("who may see, decide and collect", () => {
  it("another person can neither read nor decide the request", async () => {
    const req = await request();
    await expect(
      getKeyRequest({ requestId: req.request_id, personUserId: OTHER_PERSON })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      decideKeyRequest({
        requestId: req.request_id,
        personUserId: OTHER_PERSON,
        decision: "approve",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("only the requester collects; another computer's poll reads as an unknown code", async () => {
    const req = await request();
    await decideKeyRequest({
      requestId: req.request_id,
      personUserId: PERSON,
      decision: "approve",
    });
    expect(await collect(req.request_code, OTHER_COMPUTER)).toEqual({
      ok: false,
      error: "invalid_grant",
    });
    expect((await collect(req.request_code)).ok).toBe(true);
  });

  it("the computer lists and revokes only the keys it requested", async () => {
    const mine = await listRequestedKeys(COMPUTER);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    expect(mine.every((k) => k.templateId === "dev-loop-poster")).toBe(true);
    expect(await listRequestedKeys(OTHER_COMPUTER)).toEqual([]);

    // A key the person made themselves is not the computer's to revoke.
    const { rows } = await h.client!.query<{ id: string }>(
      `insert into api_keys (key_name, key_prefix, key_hash, scope, user_id, key_type)
       values ('own', 'synap_user_', 'x', '{hub-protocol.read}', '${PERSON}', 'user_pat') returning id`
    );
    await expect(
      revokeRequestedKey({
        requesterUserId: COMPUTER,
        keyId: rows[0]!.id,
        by: COMPUTER,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      revokeRequestedKey({
        requesterUserId: OTHER_COMPUTER,
        keyId: mine[0]!.keyId,
        by: OTHER_COMPUTER,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      await revokeRequestedKey({
        requesterUserId: COMPUTER,
        keyId: mine[0]!.keyId,
        by: COMPUTER,
      })
    ).toEqual({ revoked: true });
    const after = await listRequestedKeys(COMPUTER);
    expect(after.find((k) => k.keyId === mine[0]!.keyId)?.revokedAt).not.toBe(
      null
    );
  });
});

describe("what can be requested", () => {
  it("lists the built-in templates; an unknown one is NOT_FOUND", async () => {
    const t = await listKeyTemplates(PERSON);
    expect(t.map((x) => x.id).slice(0, 4)).toEqual([
      "dev-loop-poster",
      "website-or-pod-app",
      "read-only",
      "full-access",
    ]);
    await expect(request({ templateId: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("a lifetime longer than the template's, or a space it does not reach, is refused", async () => {
    await expect(request({ expiresInDays: 365 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(request({ expiresInDays: null })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const narrower = await request({ expiresInDays: 7 });
    expect(
      (
        await getKeyRequest({
          requestId: narrower.request_id,
          personUserId: PERSON,
        })
      ).draft.grant.expiresInDays
    ).toBe(7);
  });

  it("a person's own role with uses is a template; one without uses is not", async () => {
    const { rows } = await h.client!.query<{ id: string }>(
      `insert into grant_roles (user_id, name, description, permissions, uses, never_expires)
       values ('${PERSON}', 'My reader', '', '{document.read}', '{mcp}', false),
              ('${PERSON}', 'No door', '', '{document.read}', null, false)
       returning id`
    );
    const ids = (await listKeyTemplates(PERSON)).map((x) => x.id);
    expect(ids).toContain(rows[0]!.id);
    expect(ids).not.toContain(rows[1]!.id);
    const req = await request({ templateId: rows[0]!.id });
    expect(
      (await getKeyRequest({ requestId: req.request_id, personUserId: PERSON }))
        .draft
    ).toMatchObject({
      uses: ["mcp"],
      grant: { permissions: ["document.read"] },
    });
    // Another person's role is not a template for this person.
    await expect(
      request({ templateId: rows[0]!.id, personUserId: OTHER_PERSON })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
