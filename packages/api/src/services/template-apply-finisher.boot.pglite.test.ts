/**
 * The BOOT channel of the one finisher (`finishBootConvergence`, W4 D19/D20)
 * on PGlite, through the REAL template-state writer.
 *
 * Pinned (the hold the reconcile util used to own, now here):
 *  (1) a finished, active space takes the version the boot pass checked;
 *  (2) an UNFINISHED apply (awaiting approval / partial / layer 2 not run /
 *      failed) or a build in flight keeps its old stamp — this pass did not
 *      run every layer-2 kind, so it cannot finish that apply;
 *  (3) overlay pack versions are recorded whatever the state, and the state
 *      itself is never changed by a boot pass;
 *  (4) the version is the WHOLE-template hash: it is stamped (or a pack's
 *      recorded) only when what the pass converged covers every layer-2 kind
 *      the template declares — boot never runs capabilities / skills / cells…
 *      (review F3: the boot stamp was a durable lie for those).
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { readTemplateState } from "@synap/database";
import { pgliteTableDdl } from "../__tests__/pglite-ddl.js";
import { finishBootConvergence } from "./template-apply-finisher.js";

const OWNER = randomUUID();

/** What the space's boot pass converges: layer 1 + playbooks + rules. */
const booted = (
  version: string,
  templatePackage: Record<string, unknown> = {
    playbooks: [{ name: "Qualify" }],
  }
) => ({
  version,
  templatePackage,
  converged: ["playbooks", "rules"] as const,
});
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function space(state: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, package_slug, provisioning_status, settings) values ($1,$2,$3,'crm-${id.slice(0, 8)}',$4,$5::jsonb)`,
    [
      id,
      `Space ${id.slice(0, 8)}`,
      OWNER,
      state,
      JSON.stringify({
        template: {
          slug: `crm-${id.slice(0, 8)}`,
          version: "v-1",
          state,
          at: "t0",
          ...(state === "failed" ? { failedLayer: 2 } : {}),
        },
      }),
    ]
  );
  return id;
}

async function stateOf(id: string) {
  const { rows } = await q<{ settings: unknown }>(
    `select settings from workspaces where id = $1`,
    [id]
  );
  return readTemplateState(rows[0]!.settings);
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
}, 120_000);

describe("finishBootConvergence — the boot channel stamps only a finished apply", () => {
  it("(1) a finished, active space takes the checked version", async () => {
    const id = await space("active");
    const r = await finishBootConvergence({
      workspaceId: id,
      userId: OWNER,
      template: booted("v-2"),
    });
    expect(r.versionStamped).toBe(true);
    expect(await stateOf(id)).toMatchObject({
      state: "active",
      version: "v-2",
    });
  });

  it.each([
    "awaiting-approval",
    "partial",
    "layer-2-not-run",
    "failed",
    "building",
  ])(
    "(2) a space in state %s keeps its old stamp and its state",
    async (state) => {
      const id = await space(state);
      const r = await finishBootConvergence({
        workspaceId: id,
        userId: OWNER,
        template: booted("v-2"),
      });
      expect(r.versionStamped).toBe(false);
      expect(await stateOf(id)).toMatchObject({ state, version: "v-1" });
    }
  );

  it("(3) pack versions are recorded on an unfinished space, its state untouched", async () => {
    const id = await space("awaiting-approval");
    await finishBootConvergence({
      workspaceId: id,
      userId: OWNER,
      template: booted("v-2"),
      packs: [
        {
          slug: "pipeline-views",
          version: "p-3",
          templatePackage: { playbooks: [{ name: "Pipeline" }] },
          converged: ["playbooks"],
        },
      ],
    });
    const state = await stateOf(id);
    expect(state).toMatchObject({ state: "awaiting-approval", version: "v-1" });
    expect(
      state?.packs?.find((p) => p.slug === "pipeline-views")?.version
    ).toBe("p-3");
  });

  it.each([
    ["skills", { skills: [{ slug: "crm-coach" }] }],
    ["capabilities", { capabilities: [{ templateKey: "crm-enrich" }] }],
    ["cells", { cells: [{ key: "crm-cell" }] }],
    ["actionPlacements", { actionPlacements: [{ ref: "Qualify" }] }],
  ])(
    "(4) a template that declares %s (a layer-2 kind boot does not run) is NOT stamped by boot",
    async (kind, extra) => {
      const id = await space("active");
      const r = await finishBootConvergence({
        workspaceId: id,
        userId: OWNER,
        template: booted("v-2", {
          playbooks: [{ name: "Qualify" }],
          rules: [{ key: "r" }],
          ...extra,
        }),
      });
      expect(r).toMatchObject({ versionStamped: false, uncovered: [kind] });
      expect(await stateOf(id)).toMatchObject({
        state: "active",
        version: "v-1",
      });
    }
  );

  it("(4) an overlay pack that declares a layer-2 kind its boot pass does not run is not recorded at the new version", async () => {
    const id = await space("active");
    await finishBootConvergence({
      workspaceId: id,
      userId: OWNER,
      packs: [
        {
          slug: "rules-pack",
          version: "p-9",
          templatePackage: { playbooks: [], rules: [{ key: "r" }] },
          converged: ["playbooks"],
        },
      ],
    });
    expect(
      (await stateOf(id))?.packs?.find((p) => p.slug === "rules-pack")
    ).toBeUndefined();
  });
});
