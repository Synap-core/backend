/**
 * The agent-workspace preset MERGES into the stored settings. Re-provisioning
 * an agent workspace used to REPLACE the whole blob, which erased the owner's
 * `exposurePolicy` (and `controlPlane`) and so widened sharing back to the
 * default without anyone deciding it.
 *
 * REAL: the helper's drizzle update against a PGlite `workspaces` table built
 * from the drizzle schema. Not covered: that the provisioning route calls this
 * helper (it is its one settings write; the settings-writers tripwire counts
 * that file's writes).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { applyAgentWorkspacePreset } from "./agent-workspace-preset.js";

const client = new PGlite();
const database = drizzle(client, { schema });

beforeAll(async () => {
  const cfg = getTableConfig(schema.workspaces);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = /^(text|uuid|jsonb|boolean|integer|timestamp)/.test(t)
      ? t.replace(/\(.*\)/, "")
      : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  await client.exec(`create table "${cfg.name}" (${cols.join(", ")});`);
});

const POLICY = {
  version: 1,
  kinds: { entity: { guest: { read: "denied", create: "denied" } } },
};

async function settingsOf(id: string) {
  const res = await client.query<{ settings: Record<string, unknown> }>(
    `select settings from workspaces where id=$1`,
    [id]
  );
  return res.rows[0]!.settings;
}

describe("applyAgentWorkspacePreset", () => {
  it("keeps exposurePolicy and controlPlane, sets the three preset keys", async () => {
    const id = randomUUID();
    await client.query(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'Agent WS',$2,$3::jsonb)`,
      [
        id,
        randomUUID(),
        JSON.stringify({
          exposurePolicy: POLICY,
          controlPlane: { podId: "p1" },
          governanceMode: "strict",
        }),
      ]
    );

    await applyAgentWorkspacePreset(database as never, id, "agent-1");
    // Twice: a re-provision is the case that used to erase.
    await applyAgentWorkspacePreset(database as never, id, "agent-1");

    expect(await settingsOf(id)).toEqual({
      exposurePolicy: POLICY,
      controlPlane: { podId: "p1" },
      workspaceType: "agent",
      linkedAgentId: "agent-1",
      governanceMode: "standard",
    });
    const [row] = (
      await client.query<{ workspace_type: string }>(
        `select workspace_type from workspaces where id=$1`,
        [id]
      )
    ).rows;
    expect(row!.workspace_type).toBe("agent");
  });

  it("a NULL settings column becomes exactly the preset", async () => {
    const id = randomUUID();
    await client.query(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'Fresh',$2,null)`,
      [id, randomUUID()]
    );
    await applyAgentWorkspacePreset(database as never, id, "agent-2");
    expect(await settingsOf(id)).toEqual({
      workspaceType: "agent",
      linkedAgentId: "agent-2",
      governanceMode: "standard",
    });
  });
});
