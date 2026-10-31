/**
 * Package updates on PGlite, through the REAL `skills.update` door: the plan,
 * the apply with a choice per field, the receipt, History and Undo. Only
 * governance (a stub that proposes for an agent and grants a person), audit,
 * side effects and the catalog lookup are stubbed.
 *
 * The case is facecam-edit as the founder's pod held it on 29 Oct: the
 * catalog rewrote the skill (12 158 → 21 199 characters) and the pod had
 * added one paragraph ("Invisible cuts") that the catalog also added, word
 * for word (`__fixtures__/`, the real bodies).
 *
 * Pinned:
 *  - the plan reads `both` for that body, offers the merge (no overlap) and
 *    recommends the catalog's text, which equals the merge;
 *  - PARITY: a field the plan calls `updates` is exactly a field the
 *    reconcile's dry run would update (one comparator);
 *  - a person's apply lands through the door, advances the baseline and the
 *    version, and writes one receipt; Undo restores the text, after which the
 *    field reads as the pod's own;
 *  - "Keep mine" changes no text but advances the baseline (D4);
 *  - an agent's apply is a proposal and writes nothing;
 *  - a moved catalog answers CONFLICT; a `both` field with no choice is refused;
 *  - the start-up reconcile files an `automatic` receipt that Undo takes back;
 *  - Undo refuses when the field changed again since.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  catalogs: {} as Record<string, Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
// Governance stub: an agent's write is proposed, a person's is granted.
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async (opts: { agentUserId?: string }) =>
    opts.agentUserId
      ? { proposalId: "11111111-1111-4111-8111-111111111111" }
      : { allowed: true }
  ),
}));
vi.mock("../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(),
}));
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("../skills/skill-write-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertMayChangeSkill: async () => undefined,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => {},
}));
vi.mock("../capabilities/marketplace-install.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lookupCatalogEntry: async (_kind: string, slug: string) =>
    h.catalogs[slug] ?? null,
}));
vi.mock(
  "../capabilities/official-catalog-trust.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    admitOfficialDefinition: async () => ({ admitted: true }),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import { reconcileStandaloneConfigsToTemplates } from "../capabilities/reconcile-standalone-configs-to-templates.js";
import { readMarketSource } from "../capabilities/market-source.js";
import type { Context } from "../../types/context.js";
import { getPackageUpdatePlan, listPackageUpdates } from "./plan.js";
import { applyPackageUpdate, undoPackageUpdate } from "./apply.js";
import { listPackageUpdateReceipts } from "./receipts.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const BASE = fixture("facecam-edit.base.md");
const CATALOG = fixture("facecam-edit.catalog.md");
const LIVE_29_OCT = fixture("facecam-edit.live-29oct.md");

const OWNER = randomUUID();
const AGENT = randomUUID();
const FACE = randomUUID(); // facecam-edit: both changed
const SAME = randomUUID(); // facecam-copy: the pod already took the catalog's text
const UPD = randomUUID(); // notes-skill: body updates, description stays yours

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "timestamp"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function insertSkill(
  id: string,
  name: string,
  body: string,
  description: string,
  source: Record<string, unknown>
) {
  await q(
    `insert into skills (id, user_id, workspace_id, name, description, kind, scope, body, execution_mode, approved, metadata)
     values ($1,$2,null,$3,$4,'instruction','user',$5,'sync',true,$6::jsonb)`,
    [
      id,
      OWNER,
      name,
      description,
      body,
      JSON.stringify({ marketSource: source }),
    ]
  );
}

async function skill(id: string) {
  const { rows } = await q(
    `select body, description, metadata from skills where id = $1`,
    [id]
  );
  return rows[0] as {
    body: string;
    description: string;
    metadata: Record<string, unknown>;
  };
}

const person = (): Context =>
  ({
    db,
    authenticated: true,
    userId: OWNER,
    workspaceId: null,
    workspaceRole: "owner",
  }) as unknown as Context;
const agent = (): Context =>
  ({ ...person(), agentUserId: AGENT }) as unknown as Context;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from skills; delete from events;`);
  const installed = (body: string, description = "Cuts face-camera takes") => ({
    packageVersion: "h-7ee4a9",
    installedAt: "2026-10-13T00:00:00.000Z",
    baseline: { body, description },
  });
  await insertSkill(
    FACE,
    "Face-camera editing",
    LIVE_29_OCT,
    "Cuts face-camera takes",
    {
      packageSlug: "facecam-edit",
      ...installed(BASE),
    }
  );
  await insertSkill(
    SAME,
    "Face-camera editing",
    CATALOG,
    "Cuts face-camera takes",
    {
      packageSlug: "facecam-copy",
      ...installed(BASE),
    }
  );
  await insertSkill(UPD, "Notes", "old notes", "my words", {
    packageSlug: "notes-skill",
    packageVersion: "h-1",
    installedAt: "2026-10-13T00:00:00.000Z",
    baseline: { body: "old notes", description: "catalog words" },
  });
  const facecam = {
    source: "https://cp.example",
    version: "h-587c06",
    name: "Face-camera editing",
    definition: {
      skill: {
        name: "Face-camera editing",
        body: CATALOG,
        description: "Cuts face-camera takes",
      },
    },
  };
  h.catalogs = {
    "facecam-edit": facecam,
    "facecam-copy": facecam,
    "notes-skill": {
      source: "https://cp.example",
      version: "h-2",
      name: "Notes",
      definition: {
        skill: {
          name: "Notes",
          body: "new notes",
          description: "catalog words",
        },
      },
    },
  };
});

const fieldOf = async (slug: string, key: string) => {
  const plan = await getPackageUpdatePlan(slug);
  return plan.rows[0]!.fields.find((f) => f.key === key)!;
};

describe("the update plan", () => {
  it("facecam-edit on 29 Oct: both changed, the merge equals the catalog's text", async () => {
    const plan = await getPackageUpdatePlan("facecam-edit");
    expect(plan).toMatchObject({
      installedVersion: "h-7ee4a9",
      latestVersion: "h-587c06",
      counts: { updates: 0, yours: 0, both: 1, same: 1 },
      needs: "choice",
    });
    const body = plan.rows[0]!.fields.find((f) => f.key === "body")!;
    expect(body).toMatchObject({
      state: "both",
      label: "Instructions",
      overlap: false,
    });
    expect(body.merged).toBe(CATALOG);
    expect(plan.recommended).toEqual({ [`${FACE}:body`]: "catalog" });
  });

  it("a pod that already took the catalog's text reads same", async () => {
    expect((await fieldOf("facecam-copy", "body")).state).toBe("same");
  });

  it("the list groups by what each update needs", async () => {
    const list = await listPackageUpdates();
    const bySlug = Object.fromEntries(list.updates.map((u) => [u.slug, u]));
    expect(bySlug["facecam-edit"]).toMatchObject({
      needs: "choice",
      reviewUrl: "/open/update/facecam-edit",
    });
    expect(bySlug["facecam-copy"]!.needs).toBe("nothing");
    expect(bySlug["notes-skill"]).toMatchObject({
      needs: "review",
      counts: { updates: 1, yours: 1, both: 0, same: 0 },
    });
    expect(list.unreadable).toEqual([]);
  });

  it("a package missing from the catalog is unreadable, never 'nothing waiting'", async () => {
    delete h.catalogs["notes-skill"];
    const list = await listPackageUpdates();
    expect(list.unreadable.map((u) => u.slug)).toEqual(["notes-skill"]);
  });

  it("PARITY: `updates` in the plan ⇔ updated by the reconcile's dry run", async () => {
    const report = await reconcileStandaloneConfigsToTemplates({
      dryRun: true,
    });
    const reconciled = new Set<string>();
    for (const e of report.updated) {
      const m = /would update: \[(.*)\]/.exec(e.reason);
      for (const f of m![1]!.split(",")) reconciled.add(`${e.id}:${f}`);
    }
    const planned = new Set<string>();
    for (const slug of ["facecam-edit", "facecam-copy", "notes-skill"]) {
      for (const row of (await getPackageUpdatePlan(slug)).rows) {
        for (const f of row.fields) {
          if (f.state === "updates") planned.add(`${row.rowId}:${f.key}`);
        }
      }
    }
    expect(planned.size).toBeGreaterThan(0); // non-vacuity
    expect([...planned].sort()).toEqual([...reconciled].sort());
  });
});

describe("apply, receipt and undo", () => {
  it("a person takes the catalog's text: it lands, the version advances, Undo restores", async () => {
    const res = await applyPackageUpdate(person(), {
      slug: "facecam-edit",
      expectedVersion: "h-587c06",
      choices: { [`${FACE}:body`]: "catalog" },
    });
    expect(res.status).toBe("applied");
    const receipt = res.status === "applied" ? res.receipt! : null!;
    expect(receipt).toMatchObject({ source: "person", slug: "facecam-edit" });
    expect(receipt.changes).toEqual([
      {
        rowKind: "skill",
        rowId: FACE,
        field: "body",
        before: LIVE_29_OCT,
        after: CATALOG,
      },
    ]);

    const row = await skill(FACE);
    expect(row.body).toBe(CATALOG);
    const source = readMarketSource(row.metadata)!;
    expect(source.packageVersion).toBe("h-587c06");
    expect(source.baseline.body).toBe(CATALOG);
    expect(
      (await listPackageUpdates()).updates.map((u) => u.slug)
    ).not.toContain("facecam-edit");

    const history = await listPackageUpdateReceipts({ slug: "facecam-edit" });
    expect(history.map((r) => r.id)).toEqual([receipt.id]);

    const undone = await undoPackageUpdate(person(), receipt.id);
    expect(undone.status).toBe("applied");
    expect((await skill(FACE)).body).toBe(LIVE_29_OCT);
    // The restored text is the pod's own edit now, not an update waiting.
    expect((await fieldOf("facecam-edit", "body")).state).toBe("yours");
    const [after] = await listPackageUpdateReceipts({ slug: "facecam-edit" });
    expect(after!.undoneAt).not.toBeNull();
    await expect(undoPackageUpdate(person(), receipt.id)).rejects.toMatchObject(
      {
        code: "CONFLICT",
      }
    );
  });

  it("Keep mine changes no text, and the catalog's becomes the starting point (D4)", async () => {
    const res = await applyPackageUpdate(person(), {
      slug: "facecam-edit",
      expectedVersion: "h-587c06",
      choices: { [`${FACE}:body`]: "mine" },
    });
    expect(res).toEqual({ status: "applied", receipt: null });
    const row = await skill(FACE);
    expect(row.body).toBe(LIVE_29_OCT);
    const source = readMarketSource(row.metadata)!;
    expect(source.baseline.body).toBe(CATALOG);
    expect(source.packageVersion).toBe("h-587c06");
    expect((await fieldOf("facecam-edit", "body")).state).toBe("yours");
  });

  it("an agent's apply is a proposal and writes nothing", async () => {
    const res = await applyPackageUpdate(agent(), {
      slug: "facecam-edit",
      expectedVersion: "h-587c06",
      choices: { [`${FACE}:body`]: "catalog" },
    });
    expect(res).toEqual({
      status: "proposed",
      proposalIds: ["11111111-1111-4111-8111-111111111111"],
    });
    expect((await skill(FACE)).body).toBe(LIVE_29_OCT);
    expect(await listPackageUpdateReceipts()).toEqual([]);
  });

  it("a moved catalog answers CONFLICT and writes nothing", async () => {
    await expect(
      applyPackageUpdate(person(), {
        slug: "facecam-edit",
        expectedVersion: "h-7ee4a9",
        choices: { [`${FACE}:body`]: "catalog" },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await skill(FACE)).body).toBe(LIVE_29_OCT);
  });

  it("a field both sides changed needs a choice", async () => {
    await expect(
      applyPackageUpdate(person(), {
        slug: "facecam-edit",
        expectedVersion: "h-587c06",
        choices: {},
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the start-up pass files an automatic receipt, and Undo takes it back", async () => {
    await reconcileStandaloneConfigsToTemplates({
      ids: [UPD],
      receipt: { source: "automatic" },
    });
    const row = await skill(UPD);
    expect(row.body).toBe("new notes");
    expect(row.description).toBe("my words");

    const [receipt] = await listPackageUpdateReceipts({ slug: "notes-skill" });
    expect(receipt).toMatchObject({
      source: "automatic",
      fromVersion: "h-1",
      toVersion: "h-2",
      changes: [
        {
          rowKind: "skill",
          rowId: UPD,
          field: "body",
          before: "old notes",
          after: "new notes",
        },
      ],
      undoneAt: null,
    });

    await undoPackageUpdate(person(), receipt!.id);
    expect((await skill(UPD)).body).toBe("old notes");
    expect((await fieldOf("notes-skill", "body")).state).toBe("yours");
  });

  it("Undo refuses when the field changed again since, and writes nothing", async () => {
    const res = await applyPackageUpdate(person(), {
      slug: "notes-skill",
      expectedVersion: "h-2",
      choices: {},
    });
    const receipt = res.status === "applied" ? res.receipt! : null!;
    await q(`update skills set body = 'edited later' where id = $1`, [UPD]);
    await expect(undoPackageUpdate(person(), receipt.id)).rejects.toMatchObject(
      {
        code: "CONFLICT",
      }
    );
    expect((await skill(UPD)).body).toBe("edited later");
  });
});
