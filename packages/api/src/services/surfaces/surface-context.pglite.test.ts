/**
 * A frame's context on PGlite — the REAL `resolveSurfaceContext` (real access
 * floors, the real `resolveBrand` over real `belongs_to_project` edges) from
 * stored rows to the context a host hands its frame (frame contract v3).
 *
 * One Brand space holds two brands (Synap for project S, Architech for A);
 * Synap's approved DTCG token set sets the primary colour. Content lives in
 * another space:
 *   - an entity filed into S: anchored, in its space, project S, and S's
 *     brand as frame CSS (`--synap-primary` at the token set's value);
 *   - its document body: the same context through its entity;
 *   - the project S itself: the same brand;
 *   - an entity in no project: a context with `brand: null`, not a failure;
 *   - an entity filed into a project with no brand: `brand: null`;
 *   - an entity the viewer cannot read: no context at all.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const d = drizzle(client, { schema });
  return { ...actual, db: d, getDb: async () => d };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import { resolveSurfaceContext } from "./surface-context.js";

const USER = "user-1";
const STRANGER = "user-2";
const BRAND_SPACE = randomUUID();
const CONTENT_SPACE = randomUUID();
const HIDDEN_SPACE = randomUUID();
const S = randomUUID();
const A = randomUUID();
const EMPTY_PROJECT = randomUUID();
const P_IDENTITY = randomUUID();
const P_TOKENS = randomUUID();
const P_NOTE = randomUUID();
const DEAL = randomUUID();
const DEAL_DOC = randomUUID();
const LOOSE = randomUUID();
const UNBRANDED = randomUUID();
const HIDDEN = randomUUID();

const q = (sql: string, params: unknown[] = []) => h.client!.query(sql, params);

async function entity(args: {
  id: string;
  workspaceId: string;
  profileId: string;
  title: string;
  properties?: Record<string, unknown>;
  project?: string;
  userId?: string;
  documentId?: string;
}) {
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, properties, document_id)
     values ($1,$2,$3,'note',$4,$5,$6::jsonb,$7)`,
    [
      args.id,
      args.userId ?? USER,
      args.workspaceId,
      args.profileId,
      args.title,
      JSON.stringify(args.properties ?? {}),
      args.documentId ?? null,
    ]
  );
  if (args.project) {
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type)
       values ($1,$2,$3,$4,$5,'belongs_to_project')`,
      [randomUUID(), USER, args.workspaceId, args.id, args.project]
    );
  }
}

const SYNAP_TOKENS = {
  brand: { primary: { $type: "color", $value: "#B67A38" } },
};

beforeAll(async () => {
  const seen = new Set<string>();
  for (const t of Object.values(schema)) {
    if (!is(t, PgTable)) continue;
    const name = getTableConfig(t).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(pgliteTableDdl(t));
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings, created_at) values
      ($1,'Brand',$4,$5::jsonb, now() - interval '1 day'),
      ($2,'Content',$4,'{}'::jsonb, now()),
      ($3,'Hidden',$6,'{}'::jsonb, now())`,
    [
      BRAND_SPACE,
      CONTENT_SPACE,
      HIDDEN_SPACE,
      USER,
      JSON.stringify({ workspaceCapabilities: ["brand.library"] }),
      STRANGER,
    ]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
      ($1,$4,$7,'owner'),($2,$5,$7,'owner'),($3,$6,$8,'owner')`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      BRAND_SPACE,
      CONTENT_SPACE,
      HIDDEN_SPACE,
      USER,
      STRANGER,
    ]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name) values
      ($1,$4,$5,'Synap'),($2,$4,null,'Launch The Architech'),($3,$4,null,'Empty')`,
    [S, A, EMPTY_PROJECT, USER, CONTENT_SPACE]
  );
  await q(
    `insert into profiles (id, slug, display_name) values
      ($1,'brand-identity','Brand Identity'),($2,'brand-token-set','Brand Token Set'),
      ($3,'note','Note')`,
    [P_IDENTITY, P_TOKENS, P_NOTE]
  );
  // The Brand space: two brands, Synap's with an approved DTCG token set.
  await entity({
    id: randomUUID(),
    workspaceId: BRAND_SPACE,
    profileId: P_IDENTITY,
    title: "Synap",
    properties: { "brand-status": "active" },
    project: S,
  });
  await entity({
    id: randomUUID(),
    workspaceId: BRAND_SPACE,
    profileId: P_IDENTITY,
    title: "Architech",
    properties: { "brand-status": "active" },
    project: A,
  });
  await entity({
    id: randomUUID(),
    workspaceId: BRAND_SPACE,
    profileId: P_TOKENS,
    title: "Synap tokens",
    properties: { "token-json": JSON.stringify(SYNAP_TOKENS) },
    project: S,
  });
  // The content the frames are anchored to.
  await q(
    `insert into documents (id, user_id, workspace_id, title, type) values
      ($1,$2,$3,'Deal page','html')`,
    [DEAL_DOC, USER, CONTENT_SPACE]
  );
  await entity({
    id: DEAL,
    workspaceId: CONTENT_SPACE,
    profileId: P_NOTE,
    title: "Deal",
    project: S,
    documentId: DEAL_DOC,
  });
  await entity({
    id: LOOSE,
    workspaceId: CONTENT_SPACE,
    profileId: P_NOTE,
    title: "Loose",
  });
  await entity({
    id: UNBRANDED,
    workspaceId: CONTENT_SPACE,
    profileId: P_NOTE,
    title: "Unbranded",
    project: EMPTY_PROJECT,
  });
  await entity({
    id: HIDDEN,
    workspaceId: HIDDEN_SPACE,
    profileId: P_NOTE,
    title: "Not yours",
    userId: STRANGER,
  });
});

describe("resolveSurfaceContext — a frame's anchor, place and brand", () => {
  it("an entity filed into a branded project: its space, its project, and the brand's --synap-* values", async () => {
    const result = await resolveSurfaceContext({
      userId: USER,
      anchor: { kind: "entity", id: DEAL },
      theme: "light",
      locale: "fr",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { brand, ...rest } = result.context;
    expect(rest).toEqual({
      anchor: { kind: "entity", id: DEAL },
      workspaceId: CONTENT_SPACE,
      projectId: S,
      goalId: null,
      filters: {},
      locale: "fr",
      theme: "light",
    });
    expect(brand).not.toBe(null);
    expect(brand!.css).toContain("--synap-primary:#B67A38");
    expect(brand!.hash).toMatch(/\S/);
  });

  it("its document body has the same context, through the entity whose body it is", async () => {
    const result = await resolveSurfaceContext({
      userId: USER,
      anchor: { kind: "document", id: DEAL_DOC },
    });
    expect(result.ok && result.context.projectId).toBe(S);
    expect(result.ok && result.context.brand?.css).toContain(
      "--synap-primary:#B67A38"
    );
  });

  it("the project itself wears the same brand, in its own space", async () => {
    const result = await resolveSurfaceContext({
      userId: USER,
      anchor: { kind: "project", id: S },
    });
    expect(result.ok && result.context.workspaceId).toBe(CONTENT_SPACE);
    expect(result.ok && result.context.brand?.css).toContain(
      "--synap-primary:#B67A38"
    );
  });

  it("an entity in no project: a context with brand null, not a failure", async () => {
    const result = await resolveSurfaceContext({
      userId: USER,
      anchor: { kind: "entity", id: LOOSE },
    });
    expect(result).toEqual({
      ok: true,
      context: {
        anchor: { kind: "entity", id: LOOSE },
        workspaceId: CONTENT_SPACE,
        projectId: null,
        goalId: null,
        filters: {},
        brand: null,
        locale: "en",
        theme: "dark",
      },
    });
  });

  it("an entity in a project with no brand: brand null, never another project's", async () => {
    const result = await resolveSurfaceContext({
      userId: USER,
      anchor: { kind: "entity", id: UNBRANDED },
    });
    expect(result.ok && result.context.projectId).toBe(EMPTY_PROJECT);
    expect(result.ok && result.context.brand).toBe(null);
  });

  it("the host's project lens applies where the anchor names none", async () => {
    const result = await resolveSurfaceContext({
      userId: USER,
      anchor: { kind: "workspace", id: CONTENT_SPACE },
      projectId: S,
    });
    expect(result.ok && result.context.projectId).toBe(S);
    expect(result.ok && result.context.brand?.css).toContain(
      "--synap-primary:#B67A38"
    );
  });

  it("an object the viewer cannot read has no context", async () => {
    await expect(
      resolveSurfaceContext({
        userId: USER,
        anchor: { kind: "entity", id: HIDDEN },
      })
    ).resolves.toEqual({ ok: false });
    await expect(
      resolveSurfaceContext({
        userId: USER,
        anchor: { kind: "workspace", id: HIDDEN_SPACE },
      })
    ).resolves.toEqual({ ok: false });
  });
});
