/**
 * The consent SAVES and GRANTS an AppAccess v2 (app permissions W3d,
 * decisions 51ad8d1e F1-F4 and fc37f740 design A, Q1-Q4), end to end on
 * PGlite through the REAL chain: the consent context and Allow
 * (`getOAuthConsentContext`, `decideOAuthAuthorization` →
 * `connectOAuthAppAccess` → the `app/connect` executor) → `POST /token` →
 * the person's token and its grants; the app page through the REAL `apps`
 * router (`accessOffer`, `updateAccess`, `list`).
 *
 * Pinned:
 *   S  Allow stores `approved_access` FIRST, derives the old pairs (space
 *      part only), and the token's grants are separate scopes per tier and
 *      kind of place (never a scope with both spaces and projects);
 *   B  SECURITY: anything beyond asked ∩ the person's floor is refused and
 *      NOTHING is stored (an unasked permission, a write where they only
 *      read, a space they cannot see, All spaces for a read not declared
 *      pod-wide, a project they cannot write in, a write "all");
 *   L  "all" projects is a LIVE pin: a project made later is reached at the
 *      next token, never pod-wide;
 *   U  the app page widens within the ask (Q2), never beyond; the live token
 *      stops at once;
 *   R  re-consent (Q3): a connection whose pairs cannot lift shows
 *      `reconsent` (names, was, proposed) on the consent context and on its
 *      `pod_app` row, and its OLD access keeps minting;
 *   Q  the short ask only adds permissions; its first write needs a place
 *      (Q4), refused without one.
 *
 * Seams replaced, as in pod-app.connections.pglite.test.ts: the event store
 * and `auditLog` (recorders), `createPendingProposal` (inserts on the
 * transaction given), `isPodAdmin` (a set).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  admins: new Set<string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  class RecordingEventRepository {
    constructor(_sql?: unknown) {}
    async append(event: unknown) {
      return event;
    }
  }
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    EventRepository: RecordingEventRepository,
  };
});

vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  return {
    ...actual,
    createPendingProposal: async (
      input: Record<string, unknown>,
      tx?: unknown
    ) => {
      const [row] = await ((tx ?? h.db) as any)
        .insert(schema.proposals)
        .values({
          targetType: input.targetType,
          targetId: input.targetId,
          proposalType: input.proposalType,
          workspaceId: input.workspaceId ?? null,
          status: "pending",
          data: input.data,
          agentUserId: input.agentUserId ?? null,
          createdBy: input.createdBy,
          revisionHistory: [],
          comments: [],
        })
        .returning();
      return row;
    },
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { AppRepository } from "@synap/database";
import * as schema from "@synap/database/schema";
import { computeS256Challenge } from "../routers/oauth/protocol.js";
import { oauthApp } from "../routers/oauth/routes.js";
import {
  decideOAuthAuthorization,
  getOAuthConsentContext,
} from "../routers/oauth/consent.js";
import { appsRouter } from "../routers/apps.js";
import { router } from "../trpc.js";
import { apiKeyService } from "./api-keys.js";

import type { AppAccess } from "@synap-core/types/grants";
const ISSUER = "https://pod.test.synap.live";
const STUDIO = "https://studio.example.com/.well-known/synap-client.json";
const STUDIO_CB = "https://studio.example.com/api/synap/callback";

const OWNER = "human-owner";
const OTHER_PERSON = "human-other";
const BRAND = randomUUID(); // OWNER owns it
const SHARED = randomUUID(); // OWNER owns it
const VIEWED = randomUUID(); // OWNER only views it
const HIDDEN = randomUUID(); // OWNER is not in it
const P_BRAND = randomUUID(); // project in Brand
const P_SOLO = randomUUID(); // OWNER's project in no space
const P_VIEWED = randomUUID(); // project in Viewed (OWNER reads, cannot write)
const P_HIDDEN = randomUUID(); // project in Hidden (OWNER cannot see)

const VERIFIER = "v".repeat(64);
const CHALLENGE = computeS256Challenge(VERIFIER);
const READ = "entity.post.read"; // declared pod-wide
const NOTE_READ = "entity.note.read"; // declared per space
const CREATE = "entity.post.create";
const UNASKED = "entity.task.create";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params).then((r) => r.rows);

beforeAll(async () => {
  process.env.PUBLIC_URL = ISSUER;
  process.env.POD_ADMIN_URL = "https://pod-admin.test.synap.live";
  delete process.env.POD_ADMIN_DOMAIN;
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const [id, email, name] of [
    [OWNER, "owner@x", "Ada"],
    [OTHER_PERSON, "other@x", "Bo"],
  ]) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'human')`,
      [id, email, name]
    );
  }
  for (const [id, name, owner, member, role] of [
    [BRAND, "Brand", OWNER, OWNER, "owner"],
    [SHARED, "Shared", OWNER, OWNER, "owner"],
    [VIEWED, "Viewed", OTHER_PERSON, OWNER, "viewer"],
    [HIDDEN, "Hidden", OTHER_PERSON, OTHER_PERSON, "owner"],
  ]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1, $2, $3)`, [
      id,
      name,
      owner,
    ]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), id, member, role]
    );
  }
  for (const [id, name, ws, user] of [
    [P_BRAND, "Launch", BRAND, OWNER],
    [P_SOLO, "Solo", null, OWNER],
    [P_VIEWED, "Watched", VIEWED, OTHER_PERSON],
    [P_HIDDEN, "Secret", HIDDEN, OTHER_PERSON],
  ]) {
    await q(
      `insert into projects (id, name, workspace_id, user_id, status) values ($1, $2, $3, $4, 'active')`,
      [id, name, ws, user]
    );
  }
  await q(
    `insert into oauth_clients (client_id, client_kind, client_name, redirect_uris, scopes,
       requested_permissions, requested_templates, requested_pod_wide, metadata_fetched_at, metadata_expires_at, metadata_sha256, created_at)
     values ($1, 'cimd', 'Content Studio', $2, '{}', $3, '{}', $4, now(), now() + interval '1 hour', $5, now())`,
    [
      STUDIO,
      [STUDIO_CB],
      [READ, NOTE_READ, CREATE],
      [READ],
      createHash("sha256").update(`${STUDIO}#1`).digest("hex"),
    ]
  );
  await q(
    `alter table grants add foreign key (api_key_id) references api_keys(id) on delete cascade`
  );
}, 120_000);

beforeEach(async () => {
  await q(`delete from pod_settings`);
  // Not a proof-of-presence suite: this pod CHOSE `report` (presence.pglite owns the gate).
  await h.client!.exec(
    `insert into pod_settings (settings) values ('{"presence":{"mode":"report","changedBy":"test","changedAt":"2026-11-05T00:00:00.000Z"}}'::jsonb)`
  );
});

const ctxOf = (userId: string) =>
  ({ authenticated: true, userId, session: { id: "s" } }) as never;
const caller = (userId: string) =>
  router({ apps: appsRouter }).createCaller(ctxOf(userId)).apps;

function authorizeParams(extra: Record<string, unknown> = {}) {
  return {
    clientId: STUDIO,
    redirectUri: STUDIO_CB,
    responseType: "code",
    scope: `${READ} ${NOTE_READ} ${CREATE}`,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    state: "st",
    ...extra,
  };
}

const access = (a: Partial<AppAccess> & Pick<AppAccess, "permissions">): AppAccess => ({
  version: 2,
  read: { spaces: [], projects: [] },
  write: { spaces: [], projects: [] },
  ...a,
});

async function allow(
  input: { access?: AppAccess; askWritePlace?: { spaces: string[]; projects: string[] } },
  extra: Record<string, unknown> = {}
): Promise<string> {
  const { redirectTo } = await decideOAuthAuthorization(
    { ...authorizeParams(extra), approve: true, ...input } as never,
    OWNER,
    ctxOf(OWNER)
  );
  return new URL(redirectTo).searchParams.get("code")!;
}

async function tokenRequest(
  params: Record<string, string>
): Promise<{ status: number; body: any }> {
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.json() };
}

const exchange = (code: string) =>
  tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: STUDIO,
    redirect_uri: STUDIO_CB,
    code_verifier: VERIFIER,
  });

const refresh = (refreshToken: string) =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: STUDIO,
  });

const row = async () =>
  (
    await q<{
      id: string;
      public_id: string;
      approved_requests: Array<{ permission: string; workspaceId: string | null }> | null;
      approved_access: AppAccess | null;
    }>(
      `select id, public_id, approved_requests, approved_access from apps
        where owner_user_id = $1 and oauth_client_id = $2`,
      [OWNER, STUDIO]
    )
  )[0];

/** The live grant scopes of a token, order-free. */
async function scopesOf(token: string) {
  const id = (await apiKeyService.validateApiKey(token))!.id;
  return (
    await q<{
      permissions: string[];
      workspace_ids: string[] | null;
      project_ids: string[] | null;
    }>(
      `select permissions, workspace_ids, project_ids from grants
        where api_key_id = $1 and revoked_at is null`,
      [id]
    )
  )
    .map((g) => ({
      permissions: [...g.permissions].sort(),
      spaces: g.workspace_ids ? [...g.workspace_ids].sort() : null,
      projects: g.project_ids ? [...g.project_ids].sort() : null,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const sorted = <T>(xs: T[]) =>
  [...xs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Refused, and NOTHING about the connection changed. */
async function expectRefusedUnchanged(
  run: () => Promise<unknown>,
  message: RegExp
) {
  const before = await row();
  await expect(run()).rejects.toThrow(message);
  const after = await row();
  expect(after?.approved_access ?? null).toEqual(before?.approved_access ?? null);
  expect(after?.approved_requests ?? null).toEqual(
    before?.approved_requests ?? null
  );
}

describe("S — Allow stores v2 first and mints it per tier and kind of place", () => {
  it("the consent context names what was asked and what the person may give", async () => {
    const ctx = await getOAuthConsentContext(authorizeParams() as never, OWNER);
    const a = ctx.app!.access;
    expect(
      a.asked.permissions.map((p) => [p.permission, p.tier, p.allSpaces])
    ).toEqual([
      [READ, "read", true],
      [NOTE_READ, "read", false],
      [CREATE, "write", false],
    ]);
    expect(a.places.read.allSpaces).toBe(false); // NOTE_READ is per space
    expect(a.places.read.spaces.map((s) => s.name).sort()).toEqual([
      "Brand",
      "Shared",
      "Viewed",
    ]);
    expect(a.places.write.spaces.map((s) => s.name).sort()).toEqual([
      "Brand",
      "Shared",
    ]);
    expect(a.places.read.projects.map((p) => p.name).sort()).toEqual([
      "Launch",
      "Solo",
      "Watched",
    ]);
    expect(a.places.write.projects.map((p) => p.name).sort()).toEqual([
      "Launch",
      "Solo",
    ]);
    expect(a.current).toBeNull();
    expect(a.reconsent).toBeNull();
  });

  it("stores the access, derives the space pairs, and the token reaches the project in its own scope", async () => {
    const chosen = access({
      permissions: [READ, CREATE],
      read: { spaces: [BRAND], projects: [P_SOLO] },
      write: { spaces: [BRAND], projects: [] },
    });
    const { status, body } = await exchange(await allow({ access: chosen }));
    expect(status).toBe(200);
    const r = (await row())!;
    expect(r.approved_access).toEqual(chosen);
    expect(sorted(r.approved_requests!.map((p) => [p.permission, p.workspaceId]))).toEqual(
      sorted([
        [READ, BRAND],
        [CREATE, BRAND],
      ])
    );
    expect(await scopesOf(body.access_token)).toEqual(
      sorted([
        { permissions: [CREATE, READ].sort(), spaces: [BRAND], projects: null },
        { permissions: [READ], spaces: null, projects: [P_SOLO] },
      ])
    );
    // What the token reaches, with names: the project included.
    expect(body.synap_access).toEqual({
      version: 2,
      permissions: [READ, CREATE],
      read: {
        spaces: [{ id: BRAND, name: "Brand", templateSlug: null }],
        projects: [{ id: P_SOLO, name: "Solo", workspaceId: null }],
      },
      write: {
        spaces: [{ id: BRAND, name: "Brand", templateSlug: null }],
        projects: [],
      },
    });
  });

  it("All spaces holds only the pod-wide read, unpinned (Q1: every project with it)", async () => {
    const { body } = await exchange(
      await allow({
        access: access({
          permissions: [READ],
          read: { spaces: "all", projects: "all" },
        }),
      })
    );
    expect((await row())!.approved_access!.read).toEqual({
      spaces: "all",
      projects: [],
    });
    expect(await scopesOf(body.access_token)).toEqual([
      { permissions: [READ], spaces: null, projects: null },
    ]);
  });
});

describe("B — SECURITY: never beyond asked ∩ what the person may give; nothing stored", () => {
  beforeEach(async () => {
    await allow({
      access: access({
        permissions: [READ],
        read: { spaces: [BRAND], projects: [] },
      }),
    });
  });

  it.each([
    [
      "an unasked permission",
      access({ permissions: [UNASKED], write: { spaces: [BRAND], projects: [] } }),
      /did not ask for it/,
    ],
    [
      "a write where the person only reads",
      access({ permissions: [CREATE], write: { spaces: [VIEWED], projects: [] } }),
      /changes in space Viewed/,
    ],
    [
      "a read in a space the person cannot see",
      access({ permissions: [READ], read: { spaces: [HIDDEN], projects: [] } }),
      /reading in a space you cannot see/,
    ],
    [
      "All spaces for a read declared per space",
      access({ permissions: [NOTE_READ], read: { spaces: "all", projects: [] } }),
      /in all spaces/,
    ],
    [
      "a write in a project the person cannot write in",
      access({ permissions: [CREATE], write: { spaces: [], projects: [P_VIEWED] } }),
      /changes in project Watched/,
    ],
    [
      "a read in a project the person cannot see",
      access({ permissions: [READ], read: { spaces: [], projects: [P_HIDDEN] } }),
      /reading in a project you cannot see/,
    ],
  ])("%s is refused", async (_label, chosen, message) => {
    await expectRefusedUnchanged(() => allow({ access: chosen }), message);
    // A place the person cannot see is never named.
    await expect(allow({ access: chosen })).rejects.not.toThrow(/Hidden|Secret/);
  });

  it("a write in all spaces is not an access at all", async () => {
    await expectRefusedUnchanged(
      () =>
        allow({
          access: {
            ...access({ permissions: [CREATE] }),
            write: { spaces: "all", projects: [] },
          } as never,
        }),
      /chosen places only/
    );
    await expect(
      allow({
        access: {
          ...access({ permissions: [CREATE] }),
          write: { spaces: "all", projects: [] },
        } as never,
      })
    ).rejects.toThrow();
    expect((await row())!.approved_access!.permissions).toEqual([READ]);
  });

  it("an access that gives nothing is refused", async () => {
    await expectRefusedUnchanged(
      () => allow({ access: access({ permissions: [CREATE] }) }),
      /Choose at least one place/
    );
  });
});

describe("L — all projects is a live pin, never pod-wide", () => {
  it("a project made after the consent is reached at the next token", async () => {
    const { body } = await exchange(
      await allow({
        access: access({
          permissions: [NOTE_READ],
          read: { spaces: [], projects: "all" },
        }),
      })
    );
    expect(await scopesOf(body.access_token)).toEqual([
      {
        permissions: [NOTE_READ],
        spaces: null,
        projects: [P_BRAND, P_SOLO, P_VIEWED].sort(),
      },
    ]);
    const later = randomUUID();
    await q(
      `insert into projects (id, name, workspace_id, user_id, status) values ($1, 'Later', $2, $3, 'active')`,
      [later, BRAND, OWNER]
    );
    const next = await refresh(body.refresh_token);
    expect(next.status).toBe(200);
    expect(await scopesOf(next.body.access_token)).toEqual([
      {
        permissions: [NOTE_READ],
        spaces: null,
        projects: [P_BRAND, P_SOLO, P_VIEWED, later].sort(),
      },
    ]);
  });
});

describe("U — the app page widens within the ask (Q2), never beyond", () => {
  it("widens, refuses beyond, and stops the live token", async () => {
    const { body } = await exchange(
      await allow({
        access: access({
          permissions: [READ],
          read: { spaces: [BRAND], projects: [] },
        }),
      })
    );
    const publicId = (await row())!.public_id;
    const offer = await caller(OWNER).accessOffer({ publicId });
    expect(offer.current!.read.spaces).toEqual([
      { id: BRAND, name: "Brand", templateSlug: null },
    ]);
    // Beyond the ask: refused, nothing stored.
    await expectRefusedUnchanged(
      () =>
        caller(OWNER).updateAccess({
          publicId,
          access: access({
            permissions: [READ, UNASKED],
            read: { spaces: [BRAND], projects: [] },
            write: { spaces: [BRAND], projects: [] },
          }),
        }),
      /did not ask for it/
    );
    // Wider, within the ask: applied.
    const wider = access({
      permissions: [READ, CREATE],
      read: { spaces: [BRAND, SHARED], projects: [P_BRAND] },
      write: { spaces: [SHARED], projects: [] },
    });
    await caller(OWNER).updateAccess({ publicId, access: wider });
    expect((await row())!.approved_access).toEqual(wider);
    expect(await apiKeyService.validateApiKey(body.access_token)).toBeNull();
    const next = await refresh(body.refresh_token);
    expect(next.status).toBe(200);
    expect(await scopesOf(next.body.access_token)).toEqual(
      sorted([
        { permissions: [READ], spaces: [BRAND, SHARED].sort(), projects: null },
        { permissions: [CREATE], spaces: [SHARED], projects: null },
        { permissions: [READ], spaces: null, projects: [P_BRAND] },
      ])
    );
  });
});

describe("R — re-consent (Q3): named, and the old access keeps working", () => {
  it("pairs that cannot lift show reconsent on the context and the row, and still mint", async () => {
    const { body } = await exchange(
      await allow({
        access: access({
          permissions: [READ],
          read: { spaces: [BRAND], projects: [] },
        }),
      })
    );
    const r = (await row())!;
    // A connection approved before v2 whose pairs read at two widths.
    await new AppRepository(h.db as never).setApprovedRequests(r.id, [
      { permission: READ, workspaceId: BRAND },
      { permission: NOTE_READ, workspaceId: SHARED },
    ]);
    expect((await row())!.approved_access).toBeNull();
    const ctx = await getOAuthConsentContext(authorizeParams() as never, OWNER);
    const re = ctx.app!.access.reconsent!;
    expect(re.reason).toBe("widens");
    expect(sorted(re.was as never[])).toEqual(
      sorted([
        { permission: READ, place: { kind: "space", id: BRAND, name: "Brand" } },
        { permission: NOTE_READ, place: { kind: "space", id: SHARED, name: "Shared" } },
      ] as never[])
    );
    expect(re.proposed.read.spaces).toEqual([
      { id: BRAND, name: "Brand", templateSlug: null },
      { id: SHARED, name: "Shared", templateSlug: null },
    ]);
    expect(ctx.app!.access.current).toBeNull();
    const listed = (await caller(OWNER).list()).find(
      (a) => a.public_id === r.public_id
    )!;
    expect(listed.pod_app!.reconsent!.reason).toBe("widens");
    // The old access keeps minting until W5: one scope per space.
    const next = await refresh(body.refresh_token);
    expect(next.status).toBe(200);
    expect(await scopesOf(next.body.access_token)).toEqual(
      sorted([
        { permissions: [READ], spaces: [BRAND], projects: null },
        { permissions: [NOTE_READ], spaces: [SHARED], projects: null },
      ])
    );
    // Confirming stores v2 and ends the re-consent.
    await allow({
      access: access({
        permissions: [READ, NOTE_READ],
        read: { spaces: [BRAND, SHARED], projects: [] },
      }),
    });
    const after = await getOAuthConsentContext(authorizeParams() as never, OWNER);
    expect(after.app!.access.reconsent).toBeNull();
  });
});

describe("Q — the short ask only adds permissions; a first write needs a place (Q4)", () => {
  it("asks for the write place, refuses without it, adds with it", async () => {
    await allow({
      access: access({
        permissions: [READ],
        read: { spaces: [BRAND], projects: [P_SOLO] },
      }),
    });
    const ask = { synapAsk: `${CREATE}@${BRAND}` };
    const ctx = await getOAuthConsentContext(authorizeParams(ask) as never, OWNER);
    expect(ctx.app!.access.ask!.needsWritePlace).toBe(true);
    expect(ctx.app!.access.ask!.adds.map((i) => i.permission)).toEqual([CREATE]);
    await expectRefusedUnchanged(
      () => allow({}, ask),
      /nowhere to make changes yet/
    );
    // A place it may not give: refused.
    await expectRefusedUnchanged(
      () => allow({ askWritePlace: { spaces: [VIEWED], projects: [] } }, ask),
      /changes in space Viewed/
    );
    await allow({ askWritePlace: { spaces: [], projects: [P_SOLO] } }, ask);
    expect((await row())!.approved_access).toEqual(
      access({
        permissions: [READ, CREATE],
        read: { spaces: [BRAND], projects: [P_SOLO] },
        write: { spaces: [], projects: [P_SOLO] },
      })
    );
    // Once it writes somewhere, a place is never chosen again here, and an
    // ask for a place it does not hold is the full consent's.
    await expectRefusedUnchanged(
      () => allow({ askWritePlace: { spaces: [BRAND], projects: [] } }, ask),
      /does not have yet/
    );
    await expectRefusedUnchanged(
      () => allow({}, { synapAsk: `${NOTE_READ}@${SHARED}` }),
      /does not have yet/
    );
  });
});
