/**
 * NAMED TEMPLATE INSTANCES — `createWorkspaceFromDefinitionIdempotent` on
 * PGlite with the REAL step-1 (idempotency key) and step-1b (legacy fallback)
 * queries.
 *
 * The defect (2026-10-05): a template install is idempotent on its slug, so
 * installing `brand-library` a second time for another brand returned the
 * EXISTING Brand Library and reported it `"created"`. The fix keys a named
 * instance on `<slug>:<normalized name>` (`workspaceInstanceKey`) and keeps
 * named instances out of the legacy singleton pool both ways.
 *
 * Stubbed: the create itself (`createWorkspaceFromDefinition` inserts just the
 * workspace + owner membership rows), the template reconcile, the job queue,
 * the CP template resolver. What this CANNOT see: the doors' own wiring of
 * `instanceName` → key (covered by `packages.instance-name.test.ts`), and
 * production Postgres indexes (tables are generated without them).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { randomUUID: uuid } = await import("node:crypto");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    reconcileWorkspaceFromDefinition: async () => ({}),
    // The create: one workspace row + an owner membership — all the
    // idempotency queries read.
    createWorkspaceFromDefinition: async (input: {
      userId: string;
      workspaceName?: string;
      packageSlug?: string;
    }) => {
      const id = uuid();
      await client.query(
        `insert into workspaces (id, name, owner_id, package_slug, settings) values ($1,$2,$3,$4,'{}'::jsonb)`,
        [
          id,
          input.workspaceName ?? "Template",
          input.userId,
          input.packageSlug ?? null,
        ]
      );
      await client.query(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
        [uuid(), id, input.userId]
      );
      return { workspaceId: id };
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
import {
  createWorkspaceFromDefinitionIdempotent,
  workspaceInstanceKey,
} from "./workspace-creation-service.js";

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
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const SLUG = "brand-library";
const definition = { workspaceName: "Brand Library" } as never;

function install(userId: string, instanceName?: string) {
  return createWorkspaceFromDefinitionIdempotent({
    definition,
    userId,
    packageSlug: SLUG,
    proposalId: workspaceInstanceKey(SLUG, instanceName),
    workspaceName: instanceName,
  });
}

async function keyOf(workspaceId: string): Promise<string | null> {
  const { rows } = await q<{ k: string | null }>(
    `select provisioning_proposal_id as k from workspaces where id = $1`,
    [workspaceId]
  );
  return rows[0]?.k ?? null;
}

beforeAll(async () => {
  for (const t of [schema.workspaces, schema.workspaceMembers]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

describe("workspaceInstanceKey — the ONE derivation", () => {
  it("no name = the slug (singleton, unchanged default)", () => {
    expect(workspaceInstanceKey(SLUG)).toBe(SLUG);
  });
  it("a name = <slug>:<normalized name>, case/space-insensitive", () => {
    expect(workspaceInstanceKey(SLUG, "Architech Brand")).toBe(
      "brand-library:architech-brand"
    );
    expect(workspaceInstanceKey(SLUG, "  architech   BRAND ")).toBe(
      "brand-library:architech-brand"
    );
  });
  it("a name with no letters or digits is refused, never collapsed to the singleton", () => {
    expect(() => workspaceInstanceKey(SLUG, "!!!")).toThrow(
      /no letters or digits/
    );
  });
  it("no slug = no key (nothing to be idempotent on)", () => {
    expect(workspaceInstanceKey(undefined, "X")).toBeUndefined();
  });
});

describe("named instances on the idempotent create (PGlite)", () => {
  const U = randomUUID();
  let singleton = "";
  let architech = "";

  it("first unnamed install creates the singleton", async () => {
    const r = await install(U);
    expect(r).toMatchObject({ created: true, outcome: "created" });
    singleton = r.workspaceId;
    expect(await keyOf(singleton)).toBe(SLUG);
  });

  it("unnamed re-install REUSES the singleton (created:false)", async () => {
    const r = await install(U);
    expect(r.workspaceId).toBe(singleton);
    expect(r.created).toBe(false);
  });

  it("a NAMED install creates a NEW workspace, named and keyed after the instance", async () => {
    const r = await install(U, "Architech Brand");
    expect(r.created).toBe(true);
    expect(r.workspaceId).not.toBe(singleton);
    architech = r.workspaceId;
    expect(await keyOf(architech)).toBe("brand-library:architech-brand");
    const { rows } = await q<{ name: string }>(
      `select name from workspaces where id = $1`,
      [architech]
    );
    expect(rows[0]?.name).toBe("Architech Brand");
  });

  it("the same name again REUSES that instance", async () => {
    const r = await install(U, "architech brand");
    expect(r.workspaceId).toBe(architech);
    expect(r.created).toBe(false);
  });

  it("a different name creates a third workspace", async () => {
    const r = await install(U, "Antoine Brand");
    expect(r.created).toBe(true);
    expect([singleton, architech]).not.toContain(r.workspaceId);
  });

  it("an unnamed install still reuses the singleton, never a named instance", async () => {
    const r = await install(U);
    expect(r.workspaceId).toBe(singleton);
    expect(r.created).toBe(false);
    expect(await keyOf(architech)).toBe("brand-library:architech-brand");
  });
});

describe("named instances vs the LEGACY singleton fallback (PGlite)", () => {
  it("a first named install does NOT adopt a legacy (unkeyed) singleton", async () => {
    const U = randomUUID();
    const legacy = randomUUID();
    await q(
      `insert into workspaces (id, name, owner_id, package_slug, settings) values ($1,'Brand Library',$2,$3,'{}'::jsonb)`,
      [legacy, U, SLUG]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), legacy, U]
    );
    const r = await install(U, "Architech Brand");
    expect(r.created).toBe(true);
    expect(r.workspaceId).not.toBe(legacy);
    // The legacy row's identity is untouched (not re-stamped to the instance).
    expect(await keyOf(legacy)).toBeNull();
  });

  it("an unnamed install never adopts (and re-keys) a named instance as the singleton", async () => {
    const U = randomUUID();
    const named = await install(U, "Architech Brand");
    expect(named.created).toBe(true);
    const r = await install(U);
    expect(r.created).toBe(true);
    expect(r.workspaceId).not.toBe(named.workspaceId);
    expect(await keyOf(named.workspaceId)).toBe(
      "brand-library:architech-brand"
    );
  });
});
