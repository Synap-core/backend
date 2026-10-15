/**
 * Template health's STEP fields — the two person-states the read model could
 * not express (review2 UX-M2 / O3): "your data will change" and "an agent
 * asked". Driven through the real `listWorkspaceTemplateHealth` on PGlite:
 *
 *   • `pendingDataChanges` — from `settings.template.heldForDataChanges` (the
 *     finisher's record of a held stamp), each key resolved to its manifest
 *     sentence, minus what the `_conversions` ledger says already ran;
 *     `needsPodAdmin` from the reader. A FAILED ledger read keeps the list
 *     (never zero) and adds a row warning.
 *   • `updateProposal` — the newest PENDING `workspace/update` proposal with
 *     `operation: "template_update"` targeting the space; a decided one, or
 *     another operation, is not it.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
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
  return {
    ...actual,
    db,
    getDb: async () => db,
    getCatalogSyncStamps: async () => ({}),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { CONVERSION_MANIFEST, describeConversionOp } from "@synap/database";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import {
  DATA_CHANGES_UNCHECKED_WARNING,
  DATA_CHANGES_UNREADABLE_SENTENCE,
  dataChangesHeldSentence,
  listWorkspaceTemplateHealth,
} from "../template-health.js";

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ADMIN = randomUUID();
const MEMBER = randomUUID();
const [OP_A, OP_B] = CONVERSION_MANIFEST.ops.slice(0, 2);

async function space(template: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Builder',$2,$3::jsonb)`,
    [
      id,
      ADMIN,
      JSON.stringify({
        template: {
          slug: "builder",
          version: "h-1",
          state: "active",
          at: new Date().toISOString(),
          ...template,
        },
      }),
    ]
  );
  return id;
}

async function proposal(
  targetId: string,
  opts: { status?: string; operation?: string; at?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, target_type, target_id, proposal_type, data, status, created_at)
     values ($1,'workspace',$2,'update',$3::jsonb,$4,$5)`,
    [
      id,
      targetId,
      JSON.stringify({
        targetType: "workspace",
        data: { id: targetId, operation: opts.operation ?? "template_update" },
      }),
      opts.status ?? "pending",
      opts.at ?? new Date().toISOString(),
    ]
  );
  return id;
}

async function row(id: string, viewer: string | null = ADMIN) {
  const [r] = await listWorkspaceTemplateHealth([id], viewer);
  return r!;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  // The pod-admin space: ADMIN is its owner, MEMBER is not in it.
  const podAdmin = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, system_slug, settings) values ($1,'Pod admin',$2,'pod-admin','{}'::jsonb)`,
    [podAdmin, ADMIN]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), podAdmin, ADMIN]
  );
}, 120_000);

describe("pendingDataChanges — what the update waits on the person to agree to", () => {
  it("nothing held ⇒ null, and the row reads as before", async () => {
    const id = await space({});
    expect(await row(id)).toMatchObject({
      state: "active",
      pendingDataChanges: null,
      updateProposal: null,
      applyWarning: null,
    });
  });

  it("held keys arrive as the manifest's sentences, with the held sentence as the warning", async () => {
    // No ledger table yet would be a FAILED read: create it, empty.
    await h.client!.exec(
      `create table if not exists "_conversions" (op_key text, dry_run boolean, counts jsonb, error text)`
    );
    const id = await space({ heldForDataChanges: [OP_A!.opKey, OP_B!.opKey] });
    const r = await row(id);
    expect(r.pendingDataChanges).toEqual({
      count: 2,
      sentences: [describeConversionOp(OP_A!), describeConversionOp(OP_B!)],
      unreadable: false,
      needsPodAdmin: false,
    });
    expect(r.applyWarning).toBe(dataChangesHeldSentence("builder"));
    expect(r.warnings).toContain(dataChangesHeldSentence("builder"));
    expect(r.warnings).not.toContain(DATA_CHANGES_UNCHECKED_WARNING);
  });

  it("a reader who is not a pod admin is told they cannot agree themselves", async () => {
    const id = await space({ heldForDataChanges: [OP_A!.opKey] });
    expect((await row(id, MEMBER)).pendingDataChanges?.needsPodAdmin).toBe(
      true
    );
    expect((await row(id, null)).pendingDataChanges?.needsPodAdmin).toBe(true);
  });

  it("a change the ledger says already ran is dropped; all ran ⇒ null", async () => {
    await q(
      `insert into "_conversions" (op_key, dry_run, error) values ($1, false, null)`,
      [OP_A!.opKey]
    );
    const id = await space({ heldForDataChanges: [OP_A!.opKey, OP_B!.opKey] });
    expect((await row(id)).pendingDataChanges).toMatchObject({
      count: 1,
      sentences: [describeConversionOp(OP_B!)],
    });
    const done = await space({ heldForDataChanges: [OP_A!.opKey] });
    expect((await row(done)).pendingDataChanges).toBeNull();
    await h.client!.exec(`delete from "_conversions"`);
  });

  it("a stamp held over an UNREADABLE pending list is held, never nothing", async () => {
    // be-stamp's encoding: `[]` + the unreadable flag (never `[]` alone).
    const id = await space({
      heldForDataChanges: [],
      heldForDataChangesUnreadable: true,
    });
    const r = await row(id);
    expect(r.pendingDataChanges).toEqual({
      count: 0,
      sentences: [DATA_CHANGES_UNREADABLE_SENTENCE],
      unreadable: true,
      needsPodAdmin: false,
    });
    expect(r.applyWarning).toBe(dataChangesHeldSentence("builder"));
  });

  it("a FAILED ledger read keeps the recorded list and says so — never zero", async () => {
    await h.client!.exec(`drop table "_conversions"`);
    const id = await space({ heldForDataChanges: [OP_A!.opKey] });
    const r = await row(id);
    expect(r.pendingDataChanges).toMatchObject({ count: 1 });
    expect(r.warnings).toContain(DATA_CHANGES_UNCHECKED_WARNING);
    await h.client!.exec(
      `create table "_conversions" (op_key text, dry_run boolean, counts jsonb, error text)`
    );
  });
});

describe("updateProposal — an agent already asked to update this space", () => {
  it("the newest PENDING template_update proposal targeting the space", async () => {
    const id = await space({});
    await proposal(id, { at: "2026-10-14T10:00:00Z" });
    const newest = await proposal(id, { at: "2026-10-14T18:14:00Z" });
    expect((await row(id)).updateProposal).toEqual({ id: newest });
  });

  it("decided, or another update operation, is not an update proposal", async () => {
    const id = await space({});
    await proposal(id, { status: "approved" });
    await proposal(id, { operation: "rename" });
    expect((await row(id)).updateProposal).toBeNull();
  });
});

describe("state — one derivation for every client", () => {
  it("awaiting approval with every proposal decided reads layer-2-not-run", async () => {
    const decided = await proposal(randomUUID(), { status: "approved" });
    const id = await space({
      state: "awaiting-approval",
      proposals: [decided],
    });
    expect(await row(id)).toMatchObject({
      state: "layer-2-not-run",
      drifted: true,
      awaitingApproval: [],
    });
  });

  it("a build abandoned for over ten minutes reads failed and drifted, even when stamped current", async () => {
    const id = await space({
      state: "building",
      at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });
    expect(await row(id)).toMatchObject({ state: "failed", drifted: true });
    const live = await space({ state: "building" });
    expect(await row(live)).toMatchObject({
      state: "building",
      drifted: false,
    });
  });
});
