/**
 * The ONE brand resolution on PGlite — the REAL `resolveBrand` (real access
 * floors, the real `projectLensWhere` over real `belongs_to_project` edges)
 * from stored rows to the exported kit.
 *
 * One Brand space holds TWO brand identities — Synap (project S) and
 * Architech (project A) — each with its own colour, plus one colour in no
 * project:
 *   - kit(S) carries ONLY S's colour, kit(A) ONLY A's;
 *   - no project + no flag → `no-default-brand` (several brands);
 *   - the `default-brand` flag on Synap → Synap, with S's colour only;
 *   - a single identity → it (`only-brand`);
 *   - a project with no identity → `no-brand-for-project`, never S or A;
 *   - no Brand Library → `no-brand-space`;
 *   - a failed read THROWS — it is never reported as no brand.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { exportResolvedBrandKit, resolveBrand } from "./brand-kit-service.js";

const USER = "user-1";
const SPACE = randomUUID();
const OTHER_SPACE = randomUUID();
const S = randomUUID();
const A = randomUUID();
const EMPTY_PROJECT = randomUUID();
const I_SYNAP = randomUUID();
const I_ARCH = randomUUID();
const C_SYNAP = randomUUID();
const C_ARCH = randomUUID();
const C_LOOSE = randomUUID();
const P_IDENTITY = randomUUID();
const P_COLOR = randomUUID();

const q = (sql: string, params: unknown[] = []) => h.client!.query(sql, params);

async function entity(
  id: string,
  profileId: string,
  title: string,
  properties: Record<string, unknown>,
  project?: string
) {
  await q(
    `insert into entities (id, user_id, workspace_id, type, profile_id, title, properties)
     values ($1,$2,$3,'note',$4,$5,$6::jsonb)`,
    [id, USER, SPACE, profileId, title, JSON.stringify(properties)]
  );
  if (project) {
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type)
       values ($1,$2,$3,$4,$5,'belongs_to_project')`,
      [randomUUID(), USER, SPACE, id, project]
    );
  }
}

const color = (hex: string) => ({ "color-role": "primary", "color-hex": hex });

async function kitColors(projectId?: string) {
  const { resolution, kitSource } = await resolveBrand({
    userId: USER,
    ...(projectId ? { projectId } : {}),
  });
  const kit = JSON.parse(exportResolvedBrandKit(kitSource, "json").content) as {
    identity?: { name: string };
    colors: Array<{ hex: string }>;
  };
  return {
    resolution,
    identity: kit.identity?.name,
    colors: kit.colors.map((c) => c.hex),
  };
}

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
      ($1,'Brand',$3,$4::jsonb, now() - interval '1 day'),
      ($2,'Content',$3,'{}'::jsonb, now())`,
    [
      SPACE,
      OTHER_SPACE,
      USER,
      JSON.stringify({ workspaceCapabilities: ["brand.library"] }),
    ]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
      ($1,$3,$5,'owner'),($2,$4,$5,'owner')`,
    [randomUUID(), randomUUID(), SPACE, OTHER_SPACE, USER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name) values
      ($1,$4,null,'Synap'),($2,$4,null,'Launch The Architech'),($3,$4,null,'Empty')`,
    [S, A, EMPTY_PROJECT, USER]
  );
  await q(
    `insert into profiles (id, slug, display_name) values
      ($1,'brand-identity','Brand Identity'),($2,'brand-color','Brand Color')`,
    [P_IDENTITY, P_COLOR]
  );
  await entity(I_SYNAP, P_IDENTITY, "Synap", { "brand-status": "active" }, S);
  await entity(
    I_ARCH,
    P_IDENTITY,
    "Architech",
    { "brand-status": "active" },
    A
  );
  await entity(C_SYNAP, P_COLOR, "Ochre", color("#b67a38"), S);
  await entity(C_ARCH, P_COLOR, "Navy", color("#102040"), A);
  await entity(C_LOOSE, P_COLOR, "Loose", color("#00ff00"));
});

beforeEach(async () => {
  // Reset the per-test mutations to the shared fixture.
  await q(`update entities set properties = properties - 'default-brand'`);
  await q(`update entities set deleted_at = null`);
});

describe("resolveBrand — one Brand space, brands by project", () => {
  it("kit(S) has only Synap's colour", async () => {
    const r = await kitColors(S);
    expect(r.resolution).toEqual({
      ok: true,
      brandWorkspaceId: SPACE,
      brandIdentityId: I_SYNAP,
      projectId: S,
      resolvedVia: "project",
    });
    expect(r.identity).toBe("Synap");
    expect(r.colors).toEqual(["#b67a38"]);
  });

  it("kit(A) has only Architech's colour", async () => {
    const r = await kitColors(A);
    expect(r.resolution).toMatchObject({
      ok: true,
      brandIdentityId: I_ARCH,
      projectId: A,
    });
    expect(r.identity).toBe("Architech");
    expect(r.colors).toEqual(["#102040"]);
  });

  it("no project, two brands, no flag → no-default-brand with the human message", async () => {
    const r = await kitColors();
    expect(r.resolution).toEqual({
      ok: false,
      reason: "no-default-brand",
      message:
        "Several brands live in your Brand space — pick a project, or mark one brand as the default.",
      brandWorkspaceId: SPACE,
      projectId: null,
    });
    expect(r.colors).toEqual([]);
  });

  it("the default-brand flag on Synap → Synap, with S's colour only", async () => {
    await q(
      `update entities set properties = properties || '{"default-brand": true}'::jsonb where id = $1`,
      [I_SYNAP]
    );
    const r = await kitColors();
    expect(r.resolution).toEqual({
      ok: true,
      brandWorkspaceId: SPACE,
      brandIdentityId: I_SYNAP,
      projectId: S,
      resolvedVia: "default-flag",
    });
    expect(r.colors).toEqual(["#b67a38"]);
  });

  it("a single identity → it (only-brand)", async () => {
    await q(`update entities set deleted_at = now() where id = $1`, [I_ARCH]);
    const r = await kitColors();
    expect(r.resolution).toMatchObject({
      ok: true,
      brandIdentityId: I_SYNAP,
      resolvedVia: "only-brand",
    });
    expect(r.colors).toEqual(["#b67a38"]);
  });

  it("a project with no brand identity → no-brand-for-project, never another project's brand", async () => {
    const r = await kitColors(EMPTY_PROJECT);
    expect(r.resolution).toMatchObject({
      ok: false,
      reason: "no-brand-for-project",
      brandWorkspaceId: SPACE,
      projectId: EMPTY_PROJECT,
    });
    expect(r.colors).toEqual([]);
  });

  it("a project the caller cannot see → no-brand-for-project", async () => {
    const r = await kitColors(randomUUID());
    expect(r.resolution).toMatchObject({
      ok: false,
      reason: "no-brand-for-project",
    });
  });

  it("no Brand Library → no-brand-space", async () => {
    const r = await resolveBrand({ userId: "stranger" });
    expect(r.resolution).toMatchObject({
      ok: false,
      reason: "no-brand-space",
      brandWorkspaceId: null,
    });
  });

  it("a failed read THROWS — it is never reported as no brand", async () => {
    await q(`alter table profiles rename to profiles_gone`);
    try {
      await expect(
        resolveBrand({ userId: USER, projectId: S })
      ).rejects.toThrow();
    } finally {
      await q(`alter table profiles_gone rename to profiles`);
    }
  });
});
