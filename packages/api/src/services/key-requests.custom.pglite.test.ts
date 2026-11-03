/**
 * A key request BY PERMISSIONS (2 Nov 2026: an agent asks for the exact key
 * it needs; the Sillage session needed one no template fitted), driven through
 * the REAL service on PGlite, exactly like a template ask
 * (`key-requests.pglite.test.ts`, whose harness this repeats).
 *
 * The security bar, each pinned here:
 *  - nothing is minted before the person approves, and the key is collected
 *    once, by the computer that asked;
 *  - the explicit list IS the ceiling: the person may narrow it, never widen
 *    it (a permission it did not name, a use, a lifetime, `*`);
 *  - the key is the PERSON's own key with the approved grant and the scopes
 *    its uses derive: never a privileged scope, whatever the list names, so
 *    it can do no more than its person, bounded by the list;
 *  - the same ask hands back the request already waiting (the permission set
 *    is part of "the same"), and the per-requester waiting cap counts these.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
import { KEY_USE_SCOPES } from "@synap-core/types/grants";
import {
  KEY_REQUEST_MAX_PENDING,
  collectKeyRequest,
  createKeyRequest,
  decideKeyRequest,
  getKeyRequest,
  listRequestedKeys,
} from "./key-requests.js";
import { CUSTOM_KEY_REQUEST_TEMPLATE_ID } from "./key-request-permissions.js";

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

/** The Sillage session's ingest key (2 Nov), which no template fitted. */
const SILLAGE = [
  "entity.source.read",
  "entity.source.create",
  "entity.source.update",
  "entity.company.read",
  "entity.company.create",
  "entity.company.update",
  "facet.create",
];
const SPACE = "55555555-5555-4555-8555-555555555555";

/** A request BY PERMISSIONS (no template), from the computer. */
const ask = (over: Partial<Parameters<typeof createKeyRequest>[0]> = {}) =>
  createKeyRequest({
    requesterUserId: COMPUTER,
    requesterKeyId: randomUUID(),
    personUserId: PERSON,
    permissions: SILLAGE,
    workspaceId: SPACE,
    name: "sillage-ingest",
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

const view = (id: string) =>
  getKeyRequest({ requestId: id, personUserId: PERSON });

describe("a key request by permissions, end to end", () => {
  beforeEach(async () => {
    await h.client!.exec(`delete from key_requests`);
  });

  it("files the list as the ceiling; the person sees it, not a template", async () => {
    const req = await ask();
    const v = await view(req.request_id);
    expect(v).toMatchObject({
      status: "pending",
      asked: "permissions",
      template: null,
      requester: { userId: COMPUTER, name: "ada-laptop", isComputer: true },
      draft: {
        name: "sillage-ingest",
        templateId: CUSTOM_KEY_REQUEST_TEMPLATE_ID,
        uses: ["hub"],
        grant: { workspaceIds: [SPACE], expiresInDays: 90 },
      },
    });
    expect([...v.draft.grant.permissions].sort()).toEqual([...SILLAGE].sort());
  });

  it("request → approve → the key, once, as the person, with exactly the list", async () => {
    const before = await apiKeyCount();
    const req = await ask();
    expect(await collect(req.request_code)).toEqual({
      ok: false,
      error: "authorization_pending",
    });
    expect(await apiKeyCount()).toBe(before); // nothing before the person decides

    await decideKeyRequest({
      requestId: req.request_id,
      personUserId: PERSON,
      decision: "approve",
    });
    expect(await apiKeyCount()).toBe(before); // approving mints nothing either

    const got = await collect(req.request_code);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(await apiKeyCount()).toBe(before + 1);
    expect(got.body.name).toBe("sillage-ingest");
    // The scopes are DERIVED from the uses: a write list on hub gets the hub
    // doors and nothing else, never a privileged scope.
    expect(got.body.scopes).toEqual([
      "hub-protocol.read",
      "hub-protocol.write",
    ]);

    const { rows } = await h.client!.query<{
      user_id: string;
      scope: string[];
    }>(`select user_id, scope from api_keys where id = $1`, [got.body.keyId]);
    expect(rows[0]!.user_id).toBe(PERSON); // the person's key, never the computer's
    const grant = await new GrantRepository(h.db as never).resolveForKey(
      got.body.keyId
    );
    expect(grant?.scopes).toHaveLength(1);
    expect([...grant!.scopes[0]!.permissions].sort()).toEqual(
      [...SILLAGE].sort()
    );
    expect(grant!.scopes[0]!.workspaceIds).toEqual([SPACE]);
    const exp = new Date(got.body.expiresAt!).getTime();
    expect(Math.abs(exp - (Date.now() + 90 * 86_400_000))).toBeLessThan(60_000);

    // Once.
    expect(await collect(req.request_code)).toEqual({
      ok: false,
      error: "expired_token",
    });
    // Another computer of the same person never collects it.
    expect(await listRequestedKeys(OTHER_COMPUTER)).toEqual([]);
    expect(
      (await listRequestedKeys(COMPUTER)).map((k) => k.templateId)
    ).toEqual([CUSTOM_KEY_REQUEST_TEMPLATE_ID]);
  });

  // Rules out: a list naming a key-making or setup permission minting a key
  // that carries the privileged scope those doors need. Scopes come from uses.
  it("a list naming key or agent doors still gets only its uses' scopes", async () => {
    const req = await ask({
      permissions: ["api_key.create", "agent.update", "entity.note.read"],
      uses: ["hub", "mcp"],
    });
    await decideKeyRequest({
      requestId: req.request_id,
      personUserId: PERSON,
      decision: "approve",
    });
    const got = await collect(req.request_code);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    for (const scope of got.body.scopes)
      expect(KEY_USE_SCOPES, scope).toContain(scope);
    expect(got.body.scopes).not.toContain("setup.agent");
    expect(got.body.scopes).not.toContain("hub-protocol.admin");
  });

  it("the person may narrow it: fewer permissions, a shorter life", async () => {
    const req = await ask();
    await decideKeyRequest({
      requestId: req.request_id,
      personUserId: PERSON,
      decision: "approve",
      draft: {
        name: "sillage read",
        uses: ["hub"],
        grant: {
          permissions: ["entity.source.read", "entity.company.read"],
          workspaceIds: [SPACE],
          expiresInDays: 7,
        },
      },
    });
    const got = await collect(req.request_code);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.body.scopes).toEqual(["hub-protocol.read"]);
    const grant = await new GrantRepository(h.db as never).resolveForKey(
      got.body.keyId
    );
    expect([...grant!.scopes[0]!.permissions].sort()).toEqual([
      "entity.company.read",
      "entity.source.read",
    ]);
  });

  // Rules out: the explicit list being a floor the reviewer can add to.
  it("approving wider than the list is refused, and the request stays pending", async () => {
    const before = await apiKeyCount();
    const req = await ask();
    const base = { permissions: SILLAGE, workspaceIds: [SPACE] };
    const wider = [
      {
        name: "x",
        uses: ["hub"],
        grant: {
          ...base,
          permissions: [...SILLAGE, "entity.person.read"],
          expiresInDays: 90,
        },
      },
      {
        name: "x",
        uses: ["hub"],
        grant: { ...base, permissions: ["*"], expiresInDays: 30 },
      },
      {
        name: "x",
        uses: ["hub"],
        grant: { ...base, permissions: ["entity.*.read"], expiresInDays: 30 },
      },
      {
        name: "x",
        uses: ["hub"],
        grant: { permissions: SILLAGE, expiresInDays: 90 },
      },
      { name: "x", uses: ["hub"], grant: { ...base, expiresInDays: 91 } },
      { name: "x", uses: ["hub"], grant: { ...base, expiresInDays: null } },
      {
        name: "x",
        uses: ["hub", "mcp"],
        grant: { ...base, expiresInDays: 90 },
      },
    ];
    for (const draft of wider)
      await expect(
        decideKeyRequest({
          requestId: req.request_id,
          personUserId: PERSON,
          decision: "approve",
          draft,
        }),
        JSON.stringify(draft)
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await view(req.request_id)).status).toBe("pending");
    expect(await apiKeyCount()).toBe(before);
  });

  it("another person can neither read nor decide it", async () => {
    const req = await ask();
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

  it("a denied request answers access_denied and mints nothing", async () => {
    const before = await apiKeyCount();
    const req = await ask();
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

describe("what a request by permissions may ask", () => {
  beforeEach(async () => {
    await h.client!.exec(`delete from key_requests`);
  });

  it("a template and a list, or neither, is refused; nothing is filed", async () => {
    await expect(ask({ templateId: "read-only" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(ask({ permissions: undefined })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      createKeyRequest({
        requesterUserId: COMPUTER,
        requesterKeyId: randomUUID(),
        personUserId: PERSON,
        templateId: "read-only",
        uses: ["mcp"],
        podAdminOrigin: ORIGIN,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { rows } = await h.client!.query<{ n: number }>(
      `select count(*)::int n from key_requests`
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("refuses *, an unknown subject or verb, and a too-long life, by name", async () => {
    await expect(ask({ permissions: ["*"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("full-access"),
    });
    await expect(ask({ permissions: ["entitty.read"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining('"entitty"'),
    });
    await expect(
      ask({ permissions: ["entity.company.frobnicate"] })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining('"frobnicate"'),
    });
    await expect(ask({ expiresInDays: null })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(ask({ expiresInDays: 366 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const year = await ask({ expiresInDays: 365 });
    expect((await view(year.request_id)).draft.grant.expiresInDays).toBe(365);
  });

  // Rules out: a different permission set handed back an older request (the
  // person would approve what they did not see), and a re-ordered list filed
  // as a second request (finding 214947f7's re-filing, by permissions).
  it("the same list is the same ask; another list is another request", async () => {
    const first = await ask();
    const again = await ask({ permissions: [...SILLAGE].reverse() });
    expect(again.request_id).toBe(first.request_id);
    expect(again.request_code).not.toBe(first.request_code);
    const fewer = await ask({ permissions: SILLAGE.slice(0, 3) });
    expect(fewer.request_id).not.toBe(first.request_id);
    const mcp = await ask({ uses: ["hub", "mcp"] });
    expect(mcp.request_id).not.toBe(first.request_id);
    // A template ask with the same name is not the same ask either.
    const template = await createKeyRequest({
      requesterUserId: COMPUTER,
      requesterKeyId: randomUUID(),
      personUserId: PERSON,
      templateId: "read-only",
      name: "sillage-ingest",
      workspaceId: SPACE,
      podAdminOrigin: ORIGIN,
    });
    expect(template.request_id).not.toBe(first.request_id);
  });

  it("counts toward the computer's waiting cap", async () => {
    for (let i = 0; i < KEY_REQUEST_MAX_PENDING; i++)
      await ask({ name: `cap ${i}` });
    await expect(ask({ name: "one too many" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
