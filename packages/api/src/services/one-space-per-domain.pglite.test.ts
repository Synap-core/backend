/**
 * ONE SPACE PER DOMAIN — `checkOneSpacePerDomain` on PGlite, with the REAL 0308
 * indexes and the REAL idempotent create, so "would this request REUSE?" is
 * the same answer the create gives, never a re-guess.
 *
 * Founder rules: a space is a domain installed once; a project filters it
 * (2026-10-05). No duplicate names or templates, no user link (2026-10-06) —
 * so the verdict no longer depends on WHO asks: a human is refused exactly
 * like an agent (the old human "note + create" minted the duplicates).
 *
 * What the check still catches after 0308: a live DOMAIN twin that does not
 * hold the template slug (a copy 0308 detached: subtype / key name the
 * template). Exact holders are left to the create (reuse, or the typed 409).
 * Doors' wiring: `packages.template-identity.test.ts` and siblings.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { randomUUID: uuid } = await import("node:crypto");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const events = { append: async () => undefined };
  return {
    ...actual,
    db,
    getDb: async () => db,
    reconcileWorkspaceFromDefinition: async () => ({}),
    // The create: the REAL repository insert (so the identity pre-check and
    // the 0308 indexes are live) + an owner membership.
    createWorkspaceFromDefinition: async (input: {
      userId: string;
      workspaceName?: string;
      definition?: { workspaceName?: string };
      packageSlug?: string;
    }) => {
      const repo = new actual.WorkspaceRepository(db, events as never);
      const ws = await repo.create(
        {
          name: input.workspaceName ?? input.definition?.workspaceName ?? "New",
          ownerId: input.userId,
          settings: input.packageSlug ? { packageSlug: input.packageSlug } : {},
        },
        input.userId
      );
      await client.query(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
        [uuid(), ws.id, input.userId]
      );
      return { workspaceId: ws.id };
    },
  };
});
vi.mock("@synap/jobs", () => ({
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("./capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: async () => null,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";

const M0308 = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../database/migrations/0308_workspace_identity_unique.sql"
  ),
  "utf8"
);
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "settings"
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** A space inserted directly (a legacy / detached / foreign row). */
async function seed(opts: {
  name: string;
  owner: string;
  member?: { userId: string; role: string };
  packageSlug?: string | null;
  key?: string | null;
  subtype?: string;
  archived?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, package_slug, provisioning_proposal_id, settings, archived_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      id,
      opts.name,
      opts.owner,
      opts.packageSlug ?? null,
      opts.key ?? null,
      JSON.stringify(opts.subtype ? { workspaceSubtype: opts.subtype } : {}),
      opts.archived ? new Date().toISOString() : null,
    ]
  );
  const m = opts.member ?? { userId: opts.owner, role: "owner" };
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,$4)`,
    [randomUUID(), id, m.userId, m.role]
  );
  return id;
}

beforeAll(async () => {
  for (const t of [schema.workspaces, schema.workspaceMembers]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await h.client!.exec(M0308);
});

import {
  checkOneSpacePerDomain,
  createWorkspaceFromDefinitionIdempotent,
} from "./workspace-creation-service.js";
import { ONE_SPACE_PER_DOMAIN_RULE } from "./one-space-per-domain.js";

const uniq = () => randomUUID().slice(0, 8);

function verdict(userId: string, slug: string, name?: string) {
  return checkOneSpacePerDomain({
    userId,
    packageSlug: slug,
    idempotencyKey: slug,
    workspaceName: name,
  });
}

describe("one space per domain — template installs (PGlite)", () => {
  it("first install (nothing live) → create", async () => {
    expect(await verdict(randomUUID(), `fresh-${uniq()}`)).toEqual({
      action: "create",
    });
  });

  it("a re-install of the caller's own template space → create (the create reuses it)", async () => {
    const U = randomUUID();
    const slug = `studio-${uniq()}`;
    await createWorkspaceFromDefinitionIdempotent({
      definition: {} as never,
      userId: U,
      packageSlug: slug,
      proposalId: slug,
      workspaceName: `Studio ${slug}`,
    });
    expect(await verdict(U, slug)).toEqual({ action: "create" });
  });

  it("a holder of the slug owned by SOMEONE ELSE → create (the create hands it back or answers the typed 409)", async () => {
    const slug = `shared-${uniq()}`;
    await seed({
      name: `Shared ${slug}`,
      owner: randomUUID(),
      packageSlug: slug,
      key: slug,
    });
    expect(await verdict(randomUUID(), slug)).toEqual({ action: "create" });
  });

  it("a twin the caller can WRITE (subtype = slug) → create: the create adopts it, nothing new is minted", async () => {
    const U = randomUUID();
    const slug = `own-${uniq()}`;
    await seed({ name: `Own ${slug}`, owner: U, subtype: slug });
    expect(await verdict(U, slug)).toEqual({ action: "create" });
  });

  it("a live DOMAIN TWIN the caller cannot adopt is REFUSED with the typed exists + guidance — for any caller", async () => {
    const U = randomUUID();
    const slug = `brand-${uniq()}`;
    const twin = await seed({
      name: `Architech ${slug}`,
      owner: randomUUID(),
      member: { userId: U, role: "viewer" },
      packageSlug: null,
      subtype: slug,
    });
    const v = await verdict(U, slug);
    expect(v.action).toBe("refuse");
    if (v.action !== "refuse") return;
    expect(v.reply).toMatchObject({
      status: "exists",
      workspaceId: twin,
      workspaceName: `Architech ${slug}`,
      matchedBy: "template",
    });
    expect(v.reply.guidance).toContain("`project_use_workspace`");
    expect(v.reply.guidance).toContain("`file_into_project`");
    expect(v.reply.guidance).toContain(ONE_SPACE_PER_DOMAIN_RULE);
    // The verdict takes no caller kind any more — it cannot exempt a human.
    expect(Object.keys(v)).toEqual(["action", "reply"]);
  });

  it("a former named-instance key without the slug column is a domain twin too", async () => {
    const U = randomUUID();
    const slug = `lib-${uniq()}`;
    await seed({
      name: `Client ${slug}`,
      owner: U,
      packageSlug: null,
      key: `${slug}:client`,
    });
    expect((await verdict(U, slug)).action).toBe("refuse");
  });

  it("an ARCHIVED twin does not hold the domain", async () => {
    const U = randomUUID();
    const slug = `gone-${uniq()}`;
    await seed({
      name: `Gone ${slug}`,
      owner: U,
      subtype: slug,
      archived: true,
    });
    expect(await verdict(U, slug)).toEqual({ action: "create" });
  });

  it("another user's twin does not hold MY domain (the twin is not a pod identity)", async () => {
    const slug = `theirs-${uniq()}`;
    await seed({ name: `Theirs ${slug}`, owner: randomUUID(), subtype: slug });
    expect(await verdict(randomUUID(), slug)).toEqual({ action: "create" });
  });
});

describe("one space per domain — freehand creates (PGlite)", () => {
  it("a freehand name is never refused here — names are the identity door's job (reuse or typed 409)", async () => {
    const U = randomUUID();
    const name = `Content ${uniq()}`;
    await seed({ name, owner: U, packageSlug: `content-${uniq()}` });
    expect(
      await checkOneSpacePerDomain({ userId: U, workspaceName: name })
    ).toEqual({ action: "create" });
    expect(
      await checkOneSpacePerDomain({ userId: U, workspaceName: "Podcasts" })
    ).toEqual({ action: "create" });
  });
});
