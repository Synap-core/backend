/**
 * `writeTemplateState` — the ONE writer of a space's template state — on a
 * real (PGlite) Postgres.
 *
 * Pinned:
 *  (1) a write onto a LEGACY row starts from the derived state, writes
 *      `settings.template`, mirrors the legacy keys and syncs the
 *      `package_slug` / `provisioning_status` columns; unrelated keys survive;
 *  (2) a state change clears the other state's keys in the mirror; a cleared
 *      stamp is removed;
 *  (3) a functional patch decides under the lock — `null` writes nothing;
 *  (4) two concurrent pack upserts BOTH survive (no lost update);
 *  (5) taking a template slug another active space holds is the typed 409;
 *  (6) `templateStateSettings` seeds a new row (the INSERT door) with the
 *      columns promoted by `WorkspaceRepository.create`.
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
import {
  readTemplateState,
  removePack,
  templateStateSettings,
  upsertPack,
  writeTemplateState,
} from "./template-state.js";
import { WorkspaceRepository } from "../repositories/workspace-repository.js";
import { EventRepository } from "../repositories/event-repository.js";

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

async function row(id: string) {
  const [r] = await q<{
    settings: Record<string, unknown>;
    package_slug: string | null;
    provisioning_status: string | null;
  }>(
    `select settings, package_slug, provisioning_status from workspaces where id = $1`,
    [id]
  );
  return r!;
}

let n = 0;
async function seed(settings: Record<string, unknown>, packageSlug?: string) {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  await q(
    `insert into workspaces (id, name, owner_id, settings, package_slug) values ($1, $2, $3, $4::jsonb, $5)`,
    [id, `Space ${n}`, USER, JSON.stringify(settings), packageSlug ?? null]
  );
  return id;
}

describe("writeTemplateState", () => {
  it("(1) a legacy row: derived, merged, template + mirror + columns written, the rest untouched", async () => {
    const id = await seed(
      {
        provisioningStatus: "failed",
        failedStep: "post-workspace",
        failedStepError: "boom",
        packageSlug: "crm",
        packageVersion: "h-old",
        layout: { keep: true },
      },
      "crm"
    );
    const written = await writeTemplateState(
      h.db,
      id,
      { state: "layer-2-not-run", pendingVersion: "h-2" },
      { userId: USER }
    );
    // The write is announced like any repository write (realtime + sync).
    const events = await q(
      `select 1 from events where subject_id = $1 and type = 'workspaces.update.completed'`,
      [id]
    );
    expect(events).toHaveLength(1);
    expect(written).toMatchObject({
      slug: "crm",
      version: "h-old",
      state: "layer-2-not-run",
      pendingVersion: "h-2",
    });
    const r = await row(id);
    expect(r.settings.template).toEqual(written);
    expect(r.settings).toMatchObject({
      layout: { keep: true },
      packageSlug: "crm",
      packageVersion: "h-old",
      provisioningStatus: "active",
      failedStep: null,
      failedStepError: null,
      templateApply: { state: "layer-2-not-run", version: "h-2" },
    });
    expect(r.provisioning_status).toBe("active");
    expect(r.package_slug).toBe("crm");
    expect(readTemplateState(r.settings)).toEqual(written);
  });

  it("(2) converging stamps, clears the record; failing records the step; clearing the stamp removes it", async () => {
    const id = await seed({ packageSlug: "stamp" }, "stamp");
    await writeTemplateState(h.db, id, { state: "active", version: "h-1" });
    let s = (await row(id)).settings;
    expect(s).toMatchObject({ packageVersion: "h-1", templateApply: null });
    await writeTemplateState(h.db, id, {
      state: "failed",
      failedLayer: 1,
      failedStep: "views",
      error: "x",
      completedSteps: ["workspace"],
    });
    const r = await row(id);
    expect(r.settings).toMatchObject({
      provisioningStatus: "failed",
      failedStep: "views",
      failedStepError: "x",
      completedSteps: ["workspace"],
    });
    expect(r.provisioning_status).toBe("failed");
    await writeTemplateState(h.db, id, { state: "building", version: null });
    s = (await row(id)).settings;
    expect("packageVersion" in s).toBe(false);
    expect(s).toMatchObject({
      provisioningStatus: "pending",
      failedStep: null,
    });
  });

  it("(3) a functional patch reads the locked row; null writes nothing", async () => {
    const id = await seed(
      { provisioningStatus: "failed", packageSlug: "fn" },
      "fn"
    );
    const out = await writeTemplateState(h.db, id, (current) =>
      current?.state === "failed" ? null : { state: "active" }
    );
    expect(out).toBeNull();
    const r = await row(id);
    expect(r.settings.template).toBeUndefined();
    expect(r.settings.provisioningStatus).toBe("failed");
    expect(
      await writeTemplateState(h.db, "00000000-0000-4000-8000-ffffffffffff", {
        state: "active",
      })
    ).toBeNull();
  });

  it("(4) concurrent pack upserts both survive (no lost update)", async () => {
    const id = await seed({ packageSlug: "base" }, "base");
    await Promise.all([
      upsertPack(h.db, id, { slug: "pack-a" }),
      upsertPack(h.db, id, { slug: "pack-b", version: "1.0" }),
      upsertPack(h.db, id, { slug: "pack-c" }),
    ]);
    const s = (await row(id)).settings;
    const slugs = (s.installedPacks as Array<{ slug: string }>)
      .map((p) => p.slug)
      .sort();
    expect(slugs).toEqual(["pack-a", "pack-b", "pack-c"]);
    expect((s.template as { packs: unknown[] }).packs).toHaveLength(3);
    // The mirror writes the legacy "" for a recorded, unearned version.
    expect(s.installedPacks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "pack-a", version: "" }),
      ])
    );
    await removePack(h.db, id, "pack-a");
    const after = readTemplateState((await row(id)).settings);
    expect(after?.packs?.map((p) => p.slug).sort()).toEqual([
      "pack-b",
      "pack-c",
    ]);
  });

  it("(5) taking a slug another active space holds is the typed identity conflict", async () => {
    await seed({ packageSlug: "taken" }, "taken");
    const id = await seed({});
    await expect(
      writeTemplateState(h.db, id, { slug: "taken" })
    ).rejects.toMatchObject({ reasonCode: "WORKSPACE_IDENTITY_CONFLICT" });
    expect((await row(id)).package_slug).toBeNull();
  });

  it("(6) templateStateSettings seeds a new row; the repository promotes its columns", async () => {
    const repo = new WorkspaceRepository(
      h.db,
      new EventRepository({
        unsafe: (t: string, p?: unknown[]) => q(t, p),
      } as never)
    );
    const ws = await repo.create(
      {
        name: "Seeded",
        ownerId: USER,
        settings: templateStateSettings({
          slug: "seeded",
          state: "building",
          completedSteps: [],
        }),
      },
      USER
    );
    const got = await row(ws.id);
    expect(got.provisioning_status).toBe("pending");
    expect(got.package_slug).toBe("seeded");
    expect(readTemplateState(got.settings)).toMatchObject({
      slug: "seeded",
      state: "building",
      completedSteps: [],
    });
  });
});
