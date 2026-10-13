/**
 * A template's `intent` (what the space produces) lands in
 * `settings.intent` through the REAL create and reconcile utils on PGlite —
 * the two writers every install door reaches (tRPC createFromDefinition /
 * reconcileFromDefinition, Hub /packages/apply, installFromCatalog, the boot
 * reconcile). The doors' zod keeping the field is pinned separately
 * (api `__tripwires__/template-intent-install-doors.test.ts`).
 *
 * Pinned:
 *  (1) create projects `{label, produces: [slug], source: 'template'}`;
 *  (2) a reconcile onto a space installed before the template declared an
 *      intent writes it (every live pod, once the catalog gains it), and a
 *      changed intent converges;
 *  (3) a definition that is NOT the space's identity (an overlay — intent
 *      stripped, no subtype — or the base-defaults pass) never clears it;
 *  (4) the identity definition that stopped declaring one retires the
 *      template's stored intent (null → the read infers again);
 *  (5) a malformed intent writes nothing half-shaped.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("../schema/index.js");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("../client-pg.js", async () => {
  const db = await h.init();
  // EventRepository speaks postgres-js `sql.unsafe(text, params)`.
  const sql = {
    unsafe: async (text: string, params?: unknown[]) =>
      (await h.client!.query(text, params ?? [])).rows,
  };
  return { db, sql, getDb: async () => db };
});

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { createWorkspaceFromDefinition } from "./create-workspace-from-definition.js";
import { reconcileWorkspaceFromDefinition } from "./reconcile-workspace-from-definition.js";
import { projectTemplateIntent } from "./workspace-intent.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = async <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
) => (await h.client!.query<T>(sql, params)).rows;

const USER = "00000000-0000-4000-8000-0000000000ab";

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one this path writes.
      }
    }
  }
  await q(`insert into users (id, email) values ($1, 'u@x.test')`, [USER]);
}, 120_000);

async function settingsOf(id: string): Promise<Record<string, unknown>> {
  const [row] = await q<{ settings: Record<string, unknown> }>(
    `select settings from workspaces where id = $1`,
    [id]
  );
  return row!.settings;
}

const INTENT = {
  label: "Product",
  produces: [{ profile: "devplane_feature" }, { profile: "devplane_story" }],
};

describe("settings.intent — projected by the create and reconcile writers", () => {
  it("(1) create projects the template intent", async () => {
    const r = await createWorkspaceFromDefinition({
      definition: { workspaceName: "Dev", intent: INTENT },
      userId: USER,
      createdBy: "provisioning",
    });
    expect((await settingsOf(r.workspaceId)).intent).toEqual({
      label: "Product",
      produces: ["devplane_feature", "devplane_story"],
      source: "template",
    });
  });

  it("(2) a reconcile writes it onto an existing space, and converges a change", async () => {
    const { workspaceId } = await createWorkspaceFromDefinition({
      definition: { workspaceName: "Sales" },
      userId: USER,
      createdBy: "provisioning",
    });
    expect((await settingsOf(workspaceId)).intent).toBeUndefined();
    const reconcile = (intent: unknown) =>
      reconcileWorkspaceFromDefinition({
        workspaceId,
        userId: USER,
        definition: { workspaceSubtype: "crm", intent } as never,
      });
    const report = await reconcile({
      label: "Sales",
      produces: [{ profile: "lead" }, { profile: "deal" }],
    });
    expect(report.settings.merged).toContain("intent");
    expect((await settingsOf(workspaceId)).intent).toEqual({
      label: "Sales",
      produces: ["lead", "deal"],
      source: "template",
    });
    await reconcile({ label: "Sales", produces: [{ profile: "deal" }] });
    expect((await settingsOf(workspaceId)).intent).toMatchObject({
      produces: ["deal"],
    });
  });

  it("(3) a definition that is not the space's identity never clears it", async () => {
    const { workspaceId } = await createWorkspaceFromDefinition({
      definition: { workspaceName: "Kept", intent: INTENT },
      userId: USER,
      createdBy: "provisioning",
    });
    await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId: USER,
      definition: { commands: [], relationDefs: [] } as never,
    });
    expect((await settingsOf(workspaceId)).intent).toMatchObject({
      label: "Product",
    });
  });

  it("(4) the identity definition without an intent retires the template's", async () => {
    const { workspaceId } = await createWorkspaceFromDefinition({
      definition: { workspaceName: "Retired", intent: INTENT },
      userId: USER,
      createdBy: "provisioning",
    });
    await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId: USER,
      definition: { workspaceSubtype: "builder" } as never,
    });
    expect((await settingsOf(workspaceId)).intent).toBeNull();
  });

  it("(5) a malformed intent writes nothing", async () => {
    const r = await createWorkspaceFromDefinition({
      definition: { workspaceName: "Bad", intent: { label: " " } as never },
      userId: USER,
      createdBy: "provisioning",
    });
    expect((await settingsOf(r.workspaceId)).intent).toBeUndefined();
    expect(
      projectTemplateIntent({
        label: "Research",
        produces: [{ profile: "finding" }, { nope: 1 }, { profile: "finding" }],
      })
    ).toEqual({ label: "Research", produces: ["finding"], source: "template" });
    expect(projectTemplateIntent({ label: "Library" })).toEqual({
      label: "Library",
      produces: [],
      source: "template",
    });
  });
});
