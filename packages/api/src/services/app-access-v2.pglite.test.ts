/**
 * AppAccess v2 in the app service (app permissions W2, decision 51ad8d1e):
 *
 *  - `grantsForApprovedRequests` (v2 when the pairs lift) permits EXACTLY
 *    what the per-space grants (`grantsForPairs`, the pre-W2 function)
 *    permit, and puts the app in the same spaces as viewer or editor, on
 *    fixtures shaped like the pod's real connections (a chat app's pod-wide
 *    reads, Content Studio / CRM per-space rows, mixed rows, synap-chat as it
 *    asks today, and the subsumption the W3c lift reads by meaning);
 *  - `grantsForApp` reads the stored v2, and a v2 left stale by a write that
 *    bypassed the repository never wins over the pairs;
 *  - `appRequestsWithin` compares v2 against v2 and still refuses a forged
 *    widening;
 *  - `AppRepository` keeps `approved_access` in step on every approval write;
 *  - the backfill: a dry run writes nothing and counts liftable / re-consent
 *    by reason; apply writes v2 for the liftable rows only, and is idempotent.
 *
 * Real: the app service, `AppRepository` and the backfill on PGlite with
 * every @synap/database table. Cannot see: production FKs.
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
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { AppRepository } from "@synap/database";
import {
  liftApprovedRequests,
  parsePermission,
  parsePlace,
  permits,
  type AppAccess,
  type GrantRequest,
} from "@synap-core/types/grants";
import {
  appRequestsWithin,
  grantsForApp,
  grantsForApprovedRequests,
  grantsForPairs,
} from "./app-connect.js";
import { backfillAppAccess } from "./app-access-backfill.js";

type Pair = { permission: string; workspaceId: string | null };
type Scope = {
  permissions: string[];
  workspaceIds?: string[];
  projectIds?: string[];
};

const CONTENT = randomUUID();
const BRAND = randomUUID();
const ECOSYSTEM = randomUUID();
const OTHER = randomUUID();
const SPACES = [CONTENT, BRAND, ECOSYSTEM, OTHER];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function requestOf(permission: string, workspaceId?: string): GrantRequest {
  const segs = parsePermission(permission);
  return segs.length === 3
    ? {
        subject: segs[0]!,
        qualifier: segs[1] === "*" ? null : segs[1]!,
        action: segs[2]!,
        workspaceId,
      }
    : { subject: segs[0]!, qualifier: null, action: segs[1]!, workspaceId };
}

/** The engine's answer for every (permission, space) of the fixture. */
function permitsTable(scopes: readonly Scope[], approved: readonly Pair[]) {
  const perms = [...new Set(approved.map((p) => p.permission))];
  const out: string[] = [];
  for (const p of perms)
    for (const ws of [...SPACES, undefined])
      if (scopes.some((s) => permits(s, requestOf(p, ws))))
        out.push(`${p}@${ws ?? "-"}`);
  return out.sort();
}

/** Where each permission holds, read the way the app doors read a scope. */
function placedPairs(scopes: readonly Scope[]) {
  const out = new Set<string>();
  for (const s of scopes) {
    const place = parsePlace(s, "app");
    const where =
      place.kind === "spaces" || place.kind === "projects"
        ? place.ids.map((id) => `${place.kind}:${id}`)
        : [place.kind];
    for (const w of where) for (const p of s.permissions) out.add(`${p}@${w}`);
  }
  return [...out].sort();
}

/**
 * Where the app is PUT, read the way the app doors read a scope: each space
 * as viewer (reads only) or editor, and the pod for a scope with no space.
 */
function placement(scopes: readonly Scope[]) {
  const roles = new Map<string, string>();
  for (const s of scopes) {
    const place = parsePlace(s, "app");
    const where =
      place.kind === "spaces" || place.kind === "projects"
        ? place.ids.map((id) => `${place.kind}:${id}`)
        : [place.kind];
    const writes = s.permissions.some(
      (p) => parsePermission(p).at(-1) !== "read"
    );
    for (const w of where)
      if (roles.get(w) !== "editor") roles.set(w, writes ? "editor" : "viewer");
  }
  return [...roles].map(([w, r]) => `${w}=${r}`).sort();
}

const inEach = (perms: string[], spaces: string[]): Pair[] =>
  spaces.flatMap((workspaceId) =>
    perms.map((permission) => ({ permission, workspaceId }))
  );
const podWide = (perms: string[]): Pair[] =>
  perms.map((permission) => ({ permission, workspaceId: null }));

/** Shapes of the pod's real connections (plan 8189ae7c §1.6). */
const FIXTURES: Record<string, { pairs: Pair[]; lifts: boolean }> = {
  "Content Studio: the same reads and writes in each template space": {
    pairs: inEach(
      ["entity.post.read", "entity.post.create", "entity.post.update"],
      [CONTENT, BRAND, ECOSYSTEM]
    ),
    lifts: true,
  },
  "CRM: reads in every space, writes in one": {
    pairs: [
      ...inEach(
        ["entity.person.read", "entity.company.read"],
        [CONTENT, BRAND]
      ),
      ...inEach(["entity.person.create"], [CONTENT]),
    ],
    lifts: true,
  },
  "a chat app: pod-wide reads, a run in one space": {
    pairs: [
      ...podWide(["entity.note.read", "entity.task.read", "playbook.read"]),
      ...inEach(["playbook.run", "chat.stream"], [CONTENT]),
    ],
    lifts: true,
  },
  "synap-chat today: pod-wide reads AND the same reads per space": {
    pairs: [
      ...podWide(["entity.note.read", "document.read"]),
      ...inEach(["document.read", "track.read"], [CONTENT, BRAND]),
    ],
    lifts: false,
  },
  "Content Studio by template: each space its own kinds": {
    pairs: [
      ...inEach(["entity.post.read", "entity.post.create"], [CONTENT]),
      ...inEach(["entity.asset.read", "entity.asset.create"], [BRAND]),
    ],
    lifts: false,
  },
  "a pod-wide read beside the same read in one space": {
    pairs: [
      ...podWide(["entity.decision.read"]),
      ...inEach(["entity.decision.read"], [CONTENT]),
    ],
    lifts: false,
  },
  // synap-chat as it asks today (site.config.ts): reads of named kinds and
  // subjects pod-wide, and in each chosen space every-kind reads (entity,
  // document, relation), reads that cannot be pod-wide (track, agent) and its
  // acts. Its reads sit at two widths and v2 has one read place: "all" would
  // read every kind everywhere (widens) and drop track/agent reads (narrows).
  "synap-chat as it asks today: kinds pod-wide, every kind per space": {
    pairs: [
      ...podWide([
        "playbook.read",
        "session.read",
        "project.read",
        "entity.task.read",
        "entity.person.read",
        "entity.deal.read",
      ]),
      ...inEach(
        [
          "playbook.run",
          "session.update",
          "agent.read",
          "track.read",
          "entity.read",
          "document.read",
          "relation.read",
          "chat.stream",
        ],
        [CONTENT, BRAND]
      ),
    ],
    lifts: false,
  },
  // Subsumption (W3c): entity.person.read in BRAND adds nothing beside
  // entity.read in BRAND. The key comparison re-consented it.
  "subsumption: every-kind reads per space beside a kind's read": {
    pairs: [
      ...inEach(["entity.read"], [CONTENT, BRAND]),
      ...inEach(["entity.person.read", "entity.person.create"], [CONTENT]),
    ],
    lifts: true,
  },
  // W3c: the space read is kept by the pod-wide read, and the space stays
  // the app's (it writes there).
  "a pod-wide read beside the same read in a space it writes in": {
    pairs: [
      ...podWide(["entity.decision.read"]),
      ...inEach(["entity.decision.read", "entity.decision.create"], [CONTENT]),
    ],
    lifts: true,
  },
  "a forged or stale row: writes with no space": {
    pairs: [
      ...inEach(["entity.note.read"], [CONTENT]),
      { permission: "entity.note.update", workspaceId: null },
      { permission: "*", workspaceId: null },
    ],
    lifts: false,
  },
};

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
});

describe("grantsForApprovedRequests — v2 grants equal the per-space grants", () => {
  for (const [label, { pairs, lifts }] of Object.entries(FIXTURES)) {
    it(`${label}: same permits, same placement${lifts ? ", at most 4 scopes" : ", kept per space"}`, () => {
      const before = grantsForPairs(pairs) as Scope[];
      const after = grantsForApprovedRequests(pairs) as Scope[];
      expect(permitsTable(after, pairs)).toEqual(permitsTable(before, pairs));
      expect(placement(after)).toEqual(placement(before));
      expect("access" in liftApprovedRequests(pairs)).toBe(lifts);
      if (lifts) {
        expect(after.length).toBeLessThanOrEqual(4);
      } else {
        // A re-consent keeps today's grants exactly.
        expect(after).toEqual(before);
      }
    });
  }
});

describe("grantsForApp — the stored v2, never a stale one", () => {
  const pairs = inEach(["entity.post.read"], [CONTENT, BRAND]);
  const v2 = (spaces: string[]): AppAccess => ({
    version: 2,
    permissions: ["entity.post.read"],
    read: { spaces, projects: [] },
    write: { spaces: [], projects: [] },
  });

  it("reads the stored v2 when it says what the pairs say", () => {
    expect(
      grantsForApp({
        approvedRequests: pairs,
        approvedAccess: v2([BRAND, CONTENT]),
      })
    ).toEqual([
      { permissions: ["entity.post.read"], workspaceIds: [BRAND, CONTENT] },
    ]);
  });

  // Rules out: a raw UPDATE of approved_requests widened back by a stale v2.
  it("a stale v2 (wider than the pairs) loses to the pairs", () => {
    const narrowed = inEach(["entity.post.read"], [CONTENT]);
    const grants = grantsForApp({
      approvedRequests: narrowed,
      approvedAccess: v2([CONTENT, BRAND, ECOSYSTEM]),
    }) as Scope[];
    expect(placedPairs(grants)).toEqual([`entity.post.read@spaces:${CONTENT}`]);
  });

  // Rules out: a revoke that cleared the pairs re-attaching the old reach
  // through the v2 left beside them (review of #1183).
  it("empty or missing pairs beside a valid stored v2 mint no grants", () => {
    const stored = v2([CONTENT, BRAND]);
    expect(
      grantsForApp({ approvedRequests: [], approvedAccess: stored })
    ).toEqual([]);
    expect(
      grantsForApp({ approvedRequests: null, approvedAccess: stored })
    ).toEqual([]);
  });

  it("no v2 lifts the pairs at read time; an invalid v2 is no v2", () => {
    expect(grantsForApp({ approvedRequests: pairs })).toEqual(
      grantsForApprovedRequests(pairs)
    );
    expect(
      grantsForApp({
        approvedRequests: pairs,
        approvedAccess: { version: 2, permissions: ["x"], read: {}, write: {} },
      })
    ).toEqual(grantsForApprovedRequests(pairs));
  });

  it("a re-consent row keeps today's per-space grants", () => {
    const { pairs: mixed } =
      FIXTURES["Content Studio by template: each space its own kinds"]!;
    expect(
      grantsForApp({ approvedRequests: mixed, approvedAccess: null })
    ).toEqual(grantsForPairs(mixed));
  });
});

describe("appRequestsWithin — v2 against v2", () => {
  const asked = inEach(
    ["entity.post.read", "entity.post.create"],
    [CONTENT, BRAND]
  );

  it("approved ⊆ asked, as pairs or as v2, the same answer", () => {
    const approved = inEach(["entity.post.read"], [CONTENT, BRAND]);
    const approvedV2: AppAccess = {
      version: 2,
      permissions: ["entity.post.read"],
      read: { spaces: [CONTENT, BRAND], projects: [] },
      write: { spaces: [], projects: [] },
    };
    const askedV2: AppAccess = {
      version: 2,
      permissions: ["entity.post.read", "entity.post.create"],
      read: { spaces: [CONTENT, BRAND], projects: [] },
      write: { spaces: [CONTENT, BRAND], projects: [] },
    };
    expect(appRequestsWithin(approved, asked)).toBe(true);
    expect(appRequestsWithin(approvedV2, askedV2)).toBe(true);
    expect(appRequestsWithin(approvedV2, asked)).toBe(true);
    expect(appRequestsWithin(askedV2, approvedV2)).toBe(false);
  });

  // Rules out: a forged consent turning a read into a write, or into a space never asked.
  it("a forged widening is refused in both forms", () => {
    const forged = [
      ...inEach(["entity.post.read"], [CONTENT]),
      ...inEach(["entity.post.delete"], [CONTENT]),
    ];
    expect(appRequestsWithin(forged, asked)).toBe(false);
    expect(
      appRequestsWithin(inEach(["entity.post.read"], [ECOSYSTEM]), asked)
    ).toBe(false);
    // A pod-wide ask never covers the read in one space (a membership).
    expect(
      appRequestsWithin(
        inEach(["entity.decision.read"], [CONTENT]),
        podWide(["entity.decision.read"])
      )
    ).toBe(false);
    // A row no app may hold is within nothing when compared to a v2 ask.
    const v2Ask: AppAccess = {
      version: 2,
      permissions: ["entity.post.read"],
      read: { spaces: [CONTENT], projects: [] },
      write: { spaces: [], projects: [] },
    };
    expect(
      appRequestsWithin(
        [
          { permission: "entity.post.read", workspaceId: CONTENT },
          { permission: "entity.post.update", workspaceId: null },
        ],
        v2Ask
      )
    ).toBe(false);
  });
});

async function insertApp(
  name: string,
  approved: Pair[] | null,
  approvedAccess: unknown = null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into apps (id, owner_user_id, public_id, name, mode, metadata, redirect_uris, approved_requests, approved_access)
     values ($1, 'owner-1', $2, $3, 'specific', '{}'::jsonb, '{}', $4::jsonb, $5::jsonb)`,
    [
      id,
      `app_${id}`,
      name,
      approved === null ? null : JSON.stringify(approved),
      approvedAccess === null ? null : JSON.stringify(approvedAccess),
    ]
  );
  return id;
}

const accessOf = async (id: string) =>
  (
    await q<{ approved_access: unknown }>(
      `select approved_access from apps where id = $1`,
      [id]
    )
  ).rows[0]!.approved_access;

describe("AppRepository — approved_access in step with every approval write", () => {
  it("setApprovedRequests writes the lift, or null for a re-consent", async () => {
    const repo = new AppRepository(h.db as never);
    const id = await insertApp("Repo set", null);
    await repo.setApprovedRequests(id, inEach(["entity.post.read"], [CONTENT]));
    expect(await accessOf(id)).toEqual({
      version: 2,
      permissions: ["entity.post.read"],
      read: { spaces: [CONTENT], projects: [] },
      write: { spaces: [], projects: [] },
    });
    await repo.setApprovedRequests(
      id,
      FIXTURES["Content Studio by template: each space its own kinds"]!.pairs
    );
    expect(await accessOf(id)).toBeNull();
  });

  it("addApprovedRequests recomputes it over the merged approval", async () => {
    const repo = new AppRepository(h.db as never);
    const id = await insertApp("Repo add", null);
    await repo.setApprovedRequests(id, inEach(["entity.post.read"], [CONTENT]));
    await repo.addApprovedRequests(id, inEach(["entity.post.read"], [BRAND]));
    expect(await accessOf(id)).toMatchObject({
      read: { spaces: [CONTENT, BRAND], projects: [] },
    });
  });
});

describe("backfillAppAccess — dry run, then apply", () => {
  let ids: Record<string, string>;
  beforeAll(async () => {
    await q(`delete from apps`);
    ids = {
      studio: await insertApp(
        "Studio",
        FIXTURES[
          "Content Studio: the same reads and writes in each template space"
        ]!.pairs
      ),
      chat: await insertApp(
        "Chat",
        FIXTURES[
          "synap-chat today: pod-wide reads AND the same reads per space"
        ]!.pairs
      ),
      byTemplate: await insertApp(
        "By template",
        FIXTURES["Content Studio by template: each space its own kinds"]!.pairs
      ),
      forged: await insertApp(
        "Forged",
        FIXTURES["a forged or stale row: writes with no space"]!.pairs
      ),
      narrows: await insertApp(
        "Narrows",
        FIXTURES["a pod-wide read beside the same read in one space"]!.pairs
      ),
      chatToday: await insertApp(
        "synap-chat",
        FIXTURES[
          "synap-chat as it asks today: kinds pod-wide, every kind per space"
        ]!.pairs
      ),
      subsumed: await insertApp(
        "Subsumed",
        FIXTURES["subsumption: every-kind reads per space beside a kind's read"]!
          .pairs
      ),
      podBesideWrite: await insertApp(
        "Pod beside write",
        FIXTURES["a pod-wide read beside the same read in a space it writes in"]!
          .pairs
      ),
      none: await insertApp("Not approved", null),
    };
  });

  it("a dry run counts by outcome and reason, and writes nothing", async () => {
    const report = await backfillAppAccess({ apply: false });
    expect(report).toMatchObject({
      apply: false,
      apps: 8,
      liftable: 3,
      already: 0,
      written: 0,
      // W3c: the old synap-chat fixture (no write in its spaces) now
      // re-consents because it NARROWS (track.read per space, and the two
      // spaces it only reads), not because a key differs.
      reconsent: { total: 5, widens: 2, narrows: 2, unplaceable: 1 },
    });
    const row = (id: string) => report.rows.find((r) => r.appId === id);
    for (const id of [ids.studio, ids.subsumed, ids.podBesideWrite])
      expect(row(id)?.outcome).toBe("would-lift");
    expect(row(ids.chat)).toMatchObject({
      outcome: "reconsent",
      reason: "narrows",
      example: `would lose track.read in space:${CONTENT}`,
    });
    // synap-chat as it asks today cannot lift without widening: "all"
    // spaces would read every kind everywhere.
    expect(row(ids.chatToday)).toMatchObject({
      outcome: "reconsent",
      reason: "widens",
      example: "would allow entity.read in pod",
    });
    expect(
      report.rows.find((r) => r.appId === ids.byTemplate)?.example
    ).toMatch(/^would allow entity\.(post|asset)\.(read|create) in space:/);
    for (const id of Object.values(ids)) expect(await accessOf(id)).toBeNull();
  });

  it("apply writes v2 for the liftable rows only, and a re-run changes nothing", async () => {
    const report = await backfillAppAccess({ apply: true });
    expect(report).toMatchObject({ liftable: 3, written: 3, changed: 0 });
    expect(await accessOf(ids.studio)).toMatchObject({
      version: 2,
      read: { spaces: [CONTENT, BRAND, ECOSYSTEM] },
      write: { spaces: [CONTENT, BRAND, ECOSYSTEM] },
    });
    expect(await accessOf(ids.podBesideWrite)).toEqual({
      version: 2,
      permissions: ["entity.decision.read", "entity.decision.create"],
      read: { spaces: "all", projects: [] },
      write: { spaces: [CONTENT], projects: [] },
    });
    for (const id of [
      ids.chat,
      ids.chatToday,
      ids.byTemplate,
      ids.forged,
      ids.narrows,
      ids.none,
    ])
      expect(await accessOf(id)).toBeNull();
    const again = await backfillAppAccess({ apply: true });
    expect(again).toMatchObject({ liftable: 3, already: 3, written: 0 });
  });
});
