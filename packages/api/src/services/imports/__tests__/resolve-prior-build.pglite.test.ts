/**
 * `resolvePriorBuild` on PGlite (tables generated from the Drizzle schema):
 * what a group's earlier bundles made, read back from THEIR stamped records.
 *
 * Pins: newest applied bundle wins per piece; an op undone on its own, a row
 * no longer live (archived Rule behaviour) and another person's proposal are
 * never reused; a still-pending newest bundle is reported (a rebuild then
 * refuses instead of twinning what it will create).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { resolvePriorBuild } from "../build.js";

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

const ME = "user-me";
let client: PGlite;
let database: Parameters<typeof resolvePriorBuild>[0]["database"];

const ids = {
  container: randomUUID(),
  oldSkill: randomUUID(),
  newSkill: randomUUID(),
  automation: randomUUID(),
  playbook: randomUUID(),
  view: randomUUID(),
};

async function proposal(args: {
  status: string;
  byOp: Record<string, unknown>;
  minutesAgo: number;
  owner?: string;
}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, subject_user_id, created_at)
     values ($1, $2, 'create', 'entity', $6, $3::jsonb, $4, now() - ($5 || ' minutes')::interval)`,
    [
      id,
      args.status,
      JSON.stringify({ materialized: { byOp: args.byOp } }),
      args.owner ?? ME,
      String(args.minutesAgo),
      id,
    ]
  );
  return id;
}

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  database = drizzle(client, { schema }) as unknown as typeof database;

  await client.query(
    `insert into entities (id, user_id, title, properties) values ($1, $2, 'Recipes', '{}'::jsonb)`,
    [ids.container, ME]
  );
  for (const id of [ids.oldSkill, ids.newSkill]) {
    await client.query(
      `insert into skills (id, name, status) values ($1, 'Tool', 'active')`,
      [id]
    );
  }
  await client.query(
    `insert into automations (id, name, status) values ($1, 'When', 'archived')`,
    [ids.automation]
  );
  await client.query(
    `insert into playbooks (id, name, goal_template, status) values ($1, 'Cook', 'g', 'draft')`,
    [ids.playbook]
  );
  await client.query(`insert into views (id, name) values ($1, 'Recipes')`, [
    ids.view,
  ]);
}, 120_000);

describe("resolvePriorBuild", () => {
  it("reads the newest live piece per ref from applied bundles", async () => {
    const first = await proposal({
      status: "approved",
      minutesAgo: 60,
      byOp: {
        group: { op: "create_entity", entityId: ids.container, linked: false },
        tool: { op: "create_skill", skillId: ids.oldSkill },
        rule_when: { op: "create_automation", automationId: ids.automation },
        template: { op: "create_playbook", playbookId: ids.playbook },
        list: { op: "create_view", viewId: ids.view, revertedAt: "x" },
      },
    });
    const second = await proposal({
      status: "auto_approved",
      minutesAgo: 10,
      byOp: {
        group: { op: "update_entity", entityId: ids.container },
        tool: {
          op: "update_skill",
          update: { kind: "skill", id: ids.newSkill, before: {}, after: {} },
        },
      },
    });
    // Someone else's bundle naming a view — never ours to reuse.
    const foreign = await proposal({
      status: "approved",
      minutesAgo: 5,
      owner: "user-other",
      byOp: { list: { op: "create_view", viewId: ids.view } },
    });

    const { prior, pending } = await resolvePriorBuild({
      database,
      userId: ME,
      proposalIds: [first, second, foreign],
    });
    expect(pending).toBe(false);
    expect(prior).toEqual({
      containerEntityId: ids.container,
      // the newest bundle's update wins over the first build's create
      skillId: ids.newSkill,
      // archived ⇒ not live ⇒ a rebuild re-creates it
      // list: reverted on its own in `first`, foreign in `foreign`
      playbookId: ids.playbook,
    });
  });

  it("reports a still-pending newest bundle", async () => {
    const applied = await proposal({
      status: "approved",
      minutesAgo: 60,
      byOp: { tool: { op: "create_skill", skillId: ids.oldSkill } },
    });
    const waiting = await proposal({
      status: "pending",
      minutesAgo: 1,
      byOp: {},
    });
    const { pending } = await resolvePriorBuild({
      database,
      userId: ME,
      proposalIds: [applied, waiting],
    });
    expect(pending).toBe(true);
  });
});
