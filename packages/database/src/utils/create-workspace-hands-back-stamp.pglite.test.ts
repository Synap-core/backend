/**
 * The create/resume core never writes a template apply's outcome markers —
 * through the REAL `createWorkspaceFromDefinition` on PGlite.
 *
 * Layer 1 alone does not earn the version stamp nor "active": the caller's
 * layer 2 has not run. The core hands the version back as
 * `pendingVersionStamp` and leaves the space "pending"; the api finisher
 * (`finishTemplateApply`) writes both only when layer 2 converged.
 *
 * Pinned:
 *  (1) a fresh create returns `pendingVersionStamp`, stores no
 *      `packageVersion`, and leaves `provisioningStatus: "pending"`;
 *  (2) a resume of a FAILED space clears the failure and leaves it "pending"
 *      (not "active"), with no stamp;
 *  (3) the reconcile util binds the template identity and never writes the
 *      version (W4: the boot pass's stamp now goes through the api finisher's
 *      boot channel, `finishBootConvergence`, which holds it while the last
 *      apply is unfinished — pinned in `template-apply-finisher.boot.pglite`).
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
import { readTemplateState, writeTemplateState } from "./template-state.js";

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

const USER = "00000000-0000-4000-8000-0000000000aa";

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

describe("the create/resume core hands the stamp back", () => {
  it("(1) a fresh create: pendingVersionStamp returned, nothing stamped, still pending", async () => {
    const r = await createWorkspaceFromDefinition({
      definition: { workspaceName: "Hand back" },
      userId: USER,
      packageSlug: "hand-back",
      packageVersion: "h-1",
      createdBy: "provisioning",
    });
    expect(r.pendingVersionStamp).toBe("h-1");
    const s = await settingsOf(r.workspaceId);
    expect(s.packageSlug).toBe("hand-back");
    expect(s.packageVersion).toBeUndefined();
    expect(s.provisioningStatus).toBe("pending");
    expect(readTemplateState(s)).toMatchObject({
      slug: "hand-back",
      version: null,
      state: "building",
    });
  });

  it("(2) a resume of a failed space clears the failure and stays pending, unstamped", async () => {
    const first = await createWorkspaceFromDefinition({
      definition: { workspaceName: "Resumed" },
      userId: USER,
      packageSlug: "resumed",
      createdBy: "provisioning",
    });
    await writeTemplateState(h.db, first.workspaceId, {
      state: "failed",
      failedLayer: 1,
      failedStep: "views",
    });
    const r = await createWorkspaceFromDefinition({
      definition: { workspaceName: "Resumed" },
      userId: USER,
      packageSlug: "resumed",
      packageVersion: "h-2",
      createdBy: "provisioning",
      resumeFrom: {
        workspaceId: first.workspaceId,
        completedSteps: ["workspace"],
      },
    });
    expect(r.pendingVersionStamp).toBe("h-2");
    const s = await settingsOf(first.workspaceId);
    expect(s.provisioningStatus).toBe("pending");
    expect(s.failedStep).toBeNull();
    expect(s.packageVersion).toBeUndefined();
    expect(readTemplateState(s)).toMatchObject({
      state: "building",
      version: null,
    });
    expect(readTemplateState(s)?.failedStep).toBeUndefined();
  });

  it("(3) the reconcile util binds the identity and never writes a version", async () => {
    const { workspaceId } = await createWorkspaceFromDefinition({
      definition: { workspaceName: "Boot identity" },
      userId: USER,
      createdBy: "provisioning",
    });
    await writeTemplateState(h.db, workspaceId, {
      state: "active",
      version: "h-2",
    });
    await reconcileWorkspaceFromDefinition({
      workspaceId,
      userId: USER,
      definition: { workspaceName: "Boot identity" },
      packageSlug: "boot-identity",
    });
    const s = await settingsOf(workspaceId);
    expect(readTemplateState(s)).toMatchObject({
      slug: "boot-identity",
      version: "h-2",
    });
  });
});
