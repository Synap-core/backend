/**
 * A reused profile whose existing properties cannot be read FAILS the step,
 * through the REAL `createWorkspaceFromDefinition` on PGlite.
 *
 * Before: the read sat in `catch { continue; }`, so the apply skipped that
 * profile's new properties AND its lifecycle declaration, and the space went
 * on as if it had converged. Now the error goes through `handleStepError`:
 * the create rejects, naming the step, and the space is marked failed for the
 * resume machinery.
 *
 *   Space A declares a shared kind `w0-gadget` (created there).
 *   Space B declares the same kind with one more property: the kind is REUSED,
 *   so B reads its existing properties first. That read throws (stubbed).
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
import { readTemplateState } from "./template-state.js";
import { ProfilePropertyRepository } from "../repositories/profile-property-repository.js";

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
  // The derived DDL carries no constraints; the property link upserts on
  // (profile_id, property_def_id), which needs its unique index.
  await q(
    `create unique index if not exists profile_properties_link on profile_properties (profile_id, property_def_id)`
  );
  await q(`insert into users (id, email) values ($1, 'u@x.test')`, [USER]);
}, 120_000);

const GADGET = (properties: Array<{ slug: string; label: string }>) => ({
  slug: "w0-gadget",
  displayName: "Gadget",
  scope: "shared",
  properties: properties.map((p) => ({ ...p, valueType: "text" })),
});

describe("create-workspace: a reused profile whose properties cannot be read", () => {
  it("fails the step and marks the space failed, instead of skipping the profile", async () => {
    await createWorkspaceFromDefinition({
      definition: {
        workspaceName: "Gadgets A",
        profiles: [GADGET([{ slug: "size", label: "Size" }])],
      },
      userId: USER,
      packageSlug: "gadgets-a",
      createdBy: "provisioning",
    });

    const read = vi
      .spyOn(ProfilePropertyRepository.prototype, "getByProfile")
      .mockRejectedValue(new Error("profile_properties unreadable"));
    try {
      await expect(
        createWorkspaceFromDefinition({
          definition: {
            workspaceName: "Gadgets B",
            profiles: [
              GADGET([
                { slug: "size", label: "Size" },
                { slug: "weight", label: "Weight" },
              ]),
            ],
          },
          userId: USER,
          packageSlug: "gadgets-b",
          createdBy: "provisioning",
        })
      ).rejects.toThrow(
        "Workspace creation failed at step 'profiles[w0-gadget].existingProperties': profile_properties unreadable"
      );
      // Reachability: B reused the kind and reached the read.
      expect(read).toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }

    const [b] = await q<{ settings: Record<string, unknown> }>(
      `select settings from workspaces where name = 'Gadgets B'`
    );
    expect(readTemplateState(b!.settings)).toMatchObject({
      state: "failed",
      failedStep: "profiles[w0-gadget].existingProperties",
    });
  });
});
