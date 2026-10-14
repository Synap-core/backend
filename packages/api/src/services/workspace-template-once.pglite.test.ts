/**
 * A TEMPLATE IS INSTALLED ONCE PER POD, and a NAME is held by one active
 * space (0308, founder 2026-10-06 — pod-wide, no user link) —
 * `applyLayerOne` on PGlite with the REAL 0308
 * indexes and the REAL `WorkspaceRepository` insert.
 *
 * Replaces the named-instance suite: `<slug>:<name>` second copies are
 * retired. Pinned:
 *   - a re-install (any requested name) REUSES the template's space;
 *   - a holder the caller can WRITE (owner/admin/editor) is handed back, even
 *     when another user owns it; a viewer or a non-member gets the typed 409
 *     naming it — never a second space;
 *   - a template install whose NAME collides with an unrelated space is a
 *     typed 409 (field "name") — the unrelated space is never adopted;
 *   - a freehand create by a taken name reuses the caller's own space;
 *   - a former named instance (`<slug>:<name>` key) that is the template's
 *     only active space is reused, not duplicated;
 *   - an archived template space blocks nothing.
 *
 * Stubbed: template reconcile, job queue, CP template resolver; the create
 * writes only the workspace (real repo) + owner membership. Doors' wiring:
 * `packages.template-identity.test.ts`.
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
  /** What the stubbed layer-1 reconcile writes (default: nothing). */
  onReconcile: null as
    null | ((input: { workspaceId: string }) => Promise<void>),
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
    reconcileWorkspaceFromDefinition: async (input: {
      workspaceId: string;
    }) => {
      await h.onReconcile?.(input);
      return {};
    },
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

async function activeCount(where: string, params: unknown[]): Promise<number> {
  const r = await q<{ n: number }>(
    `select count(*)::int as n from workspaces where archived_at is null and ${where}`,
    params
  );
  return r.rows[0].n;
}

beforeAll(async () => {
  for (const t of [schema.workspaces, schema.workspaceMembers]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await h.client!.exec(M0308);
});

import { applyLayerOne } from "./template-apply/layer-one.js";
import { WorkspaceIdentityConflictError } from "@synap/database";

const uniq = () => randomUUID().slice(0, 8);

function install(userId: string, slug: string, workspaceName: string) {
  return applyLayerOne({
    definition: { workspaceName } as never,
    userId,
    packageSlug: slug,
    proposalId: slug,
    workspaceName,
  });
}

async function refusal(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(WorkspaceIdentityConflictError);
  return err as WorkspaceIdentityConflictError;
}

describe("a template is installed once per pod (PGlite, real 0308 indexes)", () => {
  it("first install creates; a re-install under ANOTHER name reuses it (no second space)", async () => {
    const U = randomUUID();
    const slug = `brand-${uniq()}`;
    const first = await install(U, slug, `Brand ${slug}`);
    expect(first).toMatchObject({ created: true, outcome: "created" });
    const again = await install(U, slug, `Architech Brand ${slug}`);
    expect(again).toMatchObject({
      workspaceId: first.workspaceId,
      created: false,
    });
    expect(await activeCount("package_slug = $1", [slug])).toBe(1);
  });

  it("another user who can WRITE the holder (editor) gets it back", async () => {
    const slug = `content-${uniq()}`;
    const editor = randomUUID();
    const holder = await seed({
      name: `Content ${slug}`,
      owner: randomUUID(),
      member: { userId: editor, role: "editor" },
      packageSlug: slug,
      key: slug,
    });
    const r = await install(editor, slug, `Content ${slug}`);
    expect(r).toMatchObject({ workspaceId: holder, created: false });
    expect(await activeCount("package_slug = $1", [slug])).toBe(1);
  });

  it("a non-member, or a viewer, gets the typed 409 naming the holder — whoever owns it", async () => {
    const slug = `crm-${uniq()}`;
    const viewer = randomUUID();
    // Keyed by something else (a pre-0308 key), so the pod-wide identity step
    // — not the step-1 key lookup — is what answers.
    const holder = await seed({
      name: `CRM ${slug}`,
      owner: randomUUID(),
      member: { userId: viewer, role: "viewer" },
      packageSlug: slug,
      key: "crm-v1",
    });
    for (const caller of [randomUUID(), viewer]) {
      const e = await refusal(install(caller, slug, `Mine ${uniq()}`));
      expect(e.field).toBe("packageSlug");
      expect(e.existingWorkspaceId).toBe(holder);
      expect(e.statusCode).toBe(409);
    }
    expect(await activeCount("package_slug = $1", [slug])).toBe(1);
  });

  it("a VIEWER whose key hits does not get the space back to mutate — the typed 409, still never a second space (review F7)", async () => {
    const slug = `seen-${uniq()}`;
    const viewer = randomUUID();
    const holder = await seed({
      name: `Seen ${slug}`,
      owner: randomUUID(),
      member: { userId: viewer, role: "viewer" },
      packageSlug: slug,
      key: slug,
    });
    const e = await refusal(install(viewer, slug, `Seen ${slug}`));
    expect(e.existingWorkspaceId).toBe(holder);
    expect(await activeCount("package_slug = $1", [slug])).toBe(1);
  });

  it("a template install whose NAME is held by an unrelated space → typed 409 on the name, the space is not adopted", async () => {
    const U = randomUUID();
    const name = `Notes ${uniq()}`;
    const unrelated = await seed({ name, owner: U });
    const e = await refusal(install(U, `notes-${uniq()}`, name));
    expect(e.field).toBe("name");
    expect(e.existingWorkspaceId).toBe(unrelated);
    const [row] = (
      await q<{ package_slug: string | null }>(
        `select package_slug from workspaces where id = $1`,
        [unrelated]
      )
    ).rows;
    expect(row.package_slug).toBeNull();
  });

  it("a freehand create by a name the caller's own space holds reuses it; a stranger's is a 409", async () => {
    const U = randomUUID();
    const name = `Scratch ${uniq()}`;
    const own = await seed({ name, owner: U });
    const reuse = await applyLayerOne({
      definition: { workspaceName: name } as never,
      userId: U,
      workspaceName: `  ${name.toUpperCase()} `,
    });
    expect(reuse).toMatchObject({ workspaceId: own, created: false });
    const e = await refusal(
      applyLayerOne({
        definition: {} as never,
        userId: randomUUID(),
        workspaceName: name,
      })
    );
    expect(e).toMatchObject({ field: "name", existingWorkspaceId: own });
  });

  it("a former NAMED instance that is the template's only active space is reused, not duplicated", async () => {
    const U = randomUUID();
    const slug = `library-${uniq()}`;
    const named = await seed({
      name: `Architech ${slug}`,
      owner: U,
      packageSlug: slug,
      key: `${slug}:architech`,
    });
    const r = await install(U, slug, `Library ${slug}`);
    expect(r).toMatchObject({ workspaceId: named, created: false });
    expect(await activeCount("package_slug = $1", [slug])).toBe(1);
  });

  it("the pod's install outranks the caller's own detached twin: typed 409, the twin is never keyed", async () => {
    const U = randomUUID();
    const slug = `keeper-${uniq()}`;
    const keeper = await seed({
      name: `Keeper ${slug}`,
      owner: randomUUID(),
      packageSlug: slug,
      key: slug,
    });
    const twin = await seed({ name: `Twin ${slug}`, owner: U, subtype: slug });
    const e = await refusal(install(U, slug, `Twin ${slug}`));
    expect(e).toMatchObject({
      field: "packageSlug",
      existingWorkspaceId: keeper,
    });
    const [row] = (
      await q<{ provisioning_proposal_id: string | null }>(
        `select provisioning_proposal_id from workspaces where id = $1`,
        [twin]
      )
    ).rows;
    expect(row.provisioning_proposal_id).toBeNull();
  });

  it("with no install on the pod, the caller's own twin is adopted (reuse, no new space)", async () => {
    const U = randomUUID();
    const slug = `lone-${uniq()}`;
    const twin = await seed({ name: `Lone ${slug}`, owner: U, subtype: slug });
    const r = await install(U, slug, `Lone ${slug}`);
    expect(r).toMatchObject({ workspaceId: twin, created: false });
  });

  it("adopting a legacy twin keeps what the reconcile merged (writes only its key)", async () => {
    const U = randomUUID();
    const slug = `adopt-${uniq()}`;
    const twin = await seed({ name: `Adopt ${slug}`, owner: U, subtype: slug });
    // The reconcile merges into the stored row AFTER the adopt branch read it.
    h.onReconcile = async ({ workspaceId }) => {
      await q(
        `update workspaces set settings = settings || '{"intent":{"label":"Reconciled"}}'::jsonb where id = $1`,
        [workspaceId]
      );
    };
    try {
      const r = await applyLayerOne({
        definition: { workspaceName: `Adopt ${slug}` } as never,
        userId: U,
        packageSlug: slug,
        packageVersion: "2.0.0",
        workspaceName: `Adopt ${slug}`,
      });
      expect(r).toMatchObject({ workspaceId: twin, created: false });
    } finally {
      h.onReconcile = null;
    }
    const [row] = (
      await q<{
        settings: Record<string, unknown>;
        provisioning_proposal_id: string | null;
      }>(
        `select settings, provisioning_proposal_id from workspaces where id = $1`,
        [twin]
      )
    ).rows;
    expect(row.settings).toMatchObject({
      workspaceSubtype: slug,
      intent: { label: "Reconciled" },
      proposalId: slug,
    });
    expect(row.provisioning_proposal_id).toBe(slug);
  });

  it("an ARCHIVED template space blocks nothing — a fresh install creates, also for the SAME user who archived it (its key still matches)", async () => {
    // The discriminating input is the archiver reinstalling: the archived
    // space still carries the key AND the archiver's membership, so only an
    // archive filter on the key step keeps it from being handed back.
    const U = randomUUID();
    const slug = `old-${uniq()}`;
    const archived = await seed({
      name: `Old ${slug}`,
      owner: U,
      packageSlug: slug,
      key: slug,
      archived: true,
    });
    const r = await install(U, slug, `Old ${slug}`);
    expect(r.created).toBe(true);
    expect(r.workspaceId).not.toBe(archived);
    const other = await install(randomUUID(), `${slug}-b`, `Old b ${slug}`);
    expect(other.created).toBe(true);
  });
});
