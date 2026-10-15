/**
 * The url-reader door at its SEAM: real rows → the real `listCapabilities` →
 * the real catalog-cache read → `listReadersForUrl` / `readUrl`. Nothing in
 * between is hand-built, so this pins what the pure fixtures assume:
 *
 *   - `billing: "account"` ARRIVES — derived from the reader skill's `requires`
 *     edge to a tool that holds a credential (`credentialed` on the verb);
 *   - an installed but DISABLED pack is an `enable` offer, never an install;
 *   - an installed pack is not offered again from the catalog (container
 *     `template_key`), while a catalog reader the pod lacks IS offered;
 *   - a `read_webpage` skill that declares no URLs is no reader;
 *   - `readUrl` on an Instagram link with no free reader answers the built-in's
 *     honest `blocked needs_reader` (no network: the pod never fetches IG) and
 *     carries the offers.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
      exec: (sql: string) => Promise<unknown>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = await h.init();
  return { ...actual, db, getDb: async () => db };
});
// The IS-native manifest degrades to `[]` when the IS is unreachable.
vi.mock("@synap/intelligence-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDefaultActiveService: async () => {
      throw new Error("no IS in test");
    },
  };
});

import * as schema from "@synap/database/schema";
import type { PgTable } from "drizzle-orm/pg-core";
import { pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";
import {
  invalidateUrlReaderCache,
  listReadersForUrl,
  readUrl,
  urlReaderLookup,
} from "./url-readers.js";
import { setSkillApproved } from "./set-skill-approved.js";

const U = randomUUID();
const WS = randomUUID();
const CONTAINER = randomUUID();
const IG = "https://www.instagram.com/p/C0ffee123/";
const REEL = "https://www.instagram.com/reel/C0ffee456/";
const q = (sql: string, params: unknown[] = []) =>
  h.client!.query(sql, params) as Promise<{ rows: Array<Record<string, any>> }>;

async function skill(
  name: string,
  opts: { approved: boolean; urlPatterns: string[] | null; intent?: string }
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into skills (id, name, kind, status, approved, scope, workspace_id, user_id, metadata, url_patterns, intent)
     values ($1,$2,'code','active',$3,'pod',$4,$5,'{"readOnly":true}'::jsonb,$6,$7)`,
    [id, name, opts.approved, WS, U, opts.urlPatterns, opts.intent ?? null]
  );
  return id;
}

const link = (
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  type: string
) =>
  q(
    `insert into links (from_type, from_id, to_type, to_id, link_type) values ($1,$2,$3,$4,$5)`,
    [fromType, fromId, toType, toId, type]
  );

async function catalogEntry(slug: string, definition: Record<string, unknown>) {
  await q(
    `insert into cp_catalog_cache (source, kind, slug, name, definition) values ('https://cp.test','capability',$1,$2,$3::jsonb)`,
    [slug, `${slug} pack`, JSON.stringify(definition)]
  );
}

beforeAll(async () => {
  await h.init();
  const s = schema as unknown as Record<string, PgTable>;
  await h.client!.exec(
    pgliteSchemaDdl([
      s.tools!,
      s.skills!,
      s.vaultGrants!,
      s.links!,
      s.secrets!,
      s.capabilities!,
      s.intelligenceCommands!,
      s.workspaces!,
      s.workspaceMembers!,
      s.podMembers!,
      s.users!,
      s.projectMembers!,
      s.governanceRules!,
      s.cpCatalogCache!,
    ])
  );
  await q(`insert into users (id, email) values ($1,'u@x')`, [U]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'WS',$2,'{}'::jsonb)`,
    [WS, U]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'editor')`,
    [WS, U]
  );

  // The installed apify pack: container + credentialed tool + DISABLED reader.
  await q(
    `insert into capabilities (id, workspace_id, created_by, name, approved, template_key, metadata)
     values ($1,$2,$3,'Apify — Web Scraping',false,'apify','{"templateKey":"apify","contentHash":"hash-apify"}'::jsonb)`,
    [CONTAINER, WS, U]
  );
  const toolId = randomUUID();
  await q(
    `insert into tools (id, name, kind, approved, status, workspace_id, created_by, credential_ref, capabilities)
     values ($1,'apify_api','api',false,'active',$2,$3,'vault://11111111-1111-4111-8111-111111111111',$4::jsonb)`,
    [
      toolId,
      WS,
      U,
      JSON.stringify([
        {
          id: "capture_social_post",
          label: "Read a post",
          kind: "read",
          govDefault: "propose",
        },
      ]),
    ]
  );
  const readerId = await skill("capture_social_post", {
    approved: false,
    urlPatterns: ["instagram.com/p/*", "instagram.com/reel/*"],
    intent: "read_webpage",
  });
  await link("skill", readerId, "tool", toolId, "requires");
  await link("tool", toolId, "capability", CONTAINER, "member_of");
  await link("skill", readerId, "capability", CONTAINER, "member_of");

  // A read_webpage verb with NO urls: discoverable, never a reader.
  await skill("generic_read", {
    approved: true,
    urlPatterns: null,
    intent: "read_webpage",
  });

  // Catalog: apify (installed → not offered again) and a free reel reader (not installed).
  await catalogEntry("apify", {
    key: "apify",
    tools: [{ name: "apify_api", credentialRef: "apifyTokenSecret" }],
    skills: [
      {
        name: "capture_social_post",
        urls: ["instagram.com/p/*"],
        requires: ["apify_api"],
      },
      // A reader the catalog's NEWER apify has and this pod's install lacks:
      // the pack is installed, so it is an update, never an install offer.
      {
        name: "apify_reel_read",
        urls: ["instagram.com/reel/*"],
        requires: ["apify_api"],
      },
    ],
  });
  await catalogEntry("reel-reader", {
    key: "reel-reader",
    tools: [],
    skills: [{ name: "reel_read", urls: ["instagram.com/reel/*"] }],
  });
  invalidateUrlReaderCache();
});

describe("the url-reader door over real rows", () => {
  it("an installed, disabled, credentialed reader: one `enable` offer billing the account", async () => {
    const offers = await listReadersForUrl({ userId: U, workspaceId: WS }, IG);
    expect(offers.map((o) => o.readerId)).toEqual(["capture_social_post"]);
    expect(offers[0]).toMatchObject({
      state: "enable",
      billing: "account",
      verbId: "capture_social_post",
      capabilityId: CONTAINER,
    });
  });

  it("the catalog offers only the reader of a pack the pod lacks", async () => {
    const offers = await listReadersForUrl(
      { userId: U, workspaceId: WS },
      REEL
    );
    expect(offers.map((o) => [o.readerId, o.state, o.billing])).toEqual([
      ["capture_social_post", "enable", "account"],
      ["reel_read", "install", "none"],
    ]);
    expect(offers[1]!.installSlug).toBe("reel-reader");
  });

  it("urlReaderLookup (a Library page's rows): ONE source load, then the door's exact offers per link", async () => {
    const ctx = { userId: U, workspaceId: WS };
    invalidateUrlReaderCache();
    const lookup = await urlReaderLookup(ctx);
    // The sources are in hand: the registry can go away and every row still answers.
    await q(`alter table skills rename to skills_away`);
    let offline: Array<Array<[string, string]>>;
    try {
      offline = [IG, REEL, "https://example.com/a"].map((url) =>
        lookup(url).map((o) => [o.readerId, o.state])
      );
    } finally {
      await q(`alter table skills_away rename to skills`);
    }
    invalidateUrlReaderCache();
    const door = await Promise.all(
      [IG, REEL, "https://example.com/a"].map(async (url) =>
        (await listReadersForUrl(ctx, url)).map((o) => [o.readerId, o.state])
      )
    );
    expect(offline).toEqual(door);
    expect(offline[1]).toEqual([
      ["capture_social_post", "enable"],
      ["reel_read", "install"],
    ]);
  });

  it("readUrl on an IG link with no free reader: blocked needs_reader, offers carried", async () => {
    const r = await readUrl({ userId: U, workspaceId: WS }, IG, {
      allowBilled: false,
    });
    expect(r.read.status).toBe("blocked");
    expect(r.read.blocked?.reason).toBe("needs_reader");
    expect(r.read.via.billed).toBe(false);
    expect(r.offers.map((o) => o.state)).toEqual(["enable"]);
  });

  // LAST: it turns the pack on. The offers are cached briefly; the door that
  // turns a verb on must drop that cache, or the person who just tapped
  // "Turn on" is told "Turn on" again (R1 M2).
  it("turning the reader on through its door is seen by the very next resolve", async () => {
    await q(
      `update workspace_members set role = 'owner' where workspace_id = $1 and user_id = $2`,
      [WS, U]
    );
    const before = await listReadersForUrl({ userId: U, workspaceId: WS }, IG);
    expect(before[0]!.state).toBe("enable"); // now cached
    // The pack and its tool switched on BEHIND the cache (no door): still
    // cached as `enable` — the cache really is in the way…
    await q(`update capabilities set approved = true where id = $1`, [
      CONTAINER,
    ]);
    await q(`update tools set approved = true where workspace_id = $1`, [WS]);
    expect(
      (await listReadersForUrl({ userId: U, workspaceId: WS }, IG))[0]!.state
    ).toBe("enable");
    // …until the verb is turned on through THE door.
    const { rows } = await q(
      `select id from skills where name = 'capture_social_post'`
    );
    await setSkillApproved({ userId: U, skillId: rows[0]!.id, approved: true });
    const after = await listReadersForUrl({ userId: U, workspaceId: WS }, IG);
    expect(after[0]).toMatchObject({
      readerId: "capture_social_post",
      state: "ready",
    });
  });
});
