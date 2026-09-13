/**
 * A template re-apply onto an existing tool must not drop runtime state that a
 * running sync wrote after the applier found the row — on a real Postgres.
 *
 * A connection sync keeps its cursor, lease and proposal id in
 * `tools.metadata.sync.kinds.<kind>.connections.<id>`. A lost cursor makes the
 * next run "initial" (a second first-import proposal); a lost proposalId breaks
 * the awaiting-review guard. The applier therefore merges the template UNDER
 * the row as read inside its `FOR UPDATE` transaction.
 *
 * ENGINE: PGlite; `tools` is created from its drizzle definition (enums mapped
 * to text, constraints dropped).
 *
 * NOT covered: a true interleaving of two sessions (PGlite has one connection).
 * What is pinned is that the merge base is the row at write time, not an
 * earlier read — the helper takes only the tool id, so no earlier snapshot can
 * reach the write.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { tools } from "@synap/database/schema";
import { applyTemplateToExistingTool } from "../create-from-definition.js";

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const CURSOR = "2026-09-13T00:00:00.000Z";

describe("applyTemplateToExistingTool — runtime sync state survives a re-apply", () => {
  it("a sync checkpoint written after the applier found the row is kept; the template only fills new keys", async () => {
    const client = new PGlite();
    await client.exec(ddlFor(tools as unknown as PgTable));
    const toolId = randomUUID();
    await client.query(
      `insert into tools (id, name, config, metadata) values ($1, 'google', $2::jsonb, $3::jsonb)`,
      [
        toolId,
        JSON.stringify({ region: "eu" }),
        JSON.stringify({
          sync: { enabled: true, kinds: { event: { enabled: false } } },
        }),
      ]
    );

    // The applier's earlier read would have seen this…
    const { rows: before } = await client.query<{ metadata: unknown }>(
      `select metadata from tools where id = $1`,
      [toolId]
    );
    // …and then a running sync checkpoints.
    await client.query(
      `update tools set metadata = jsonb_set(metadata, '{sync,kinds,event,connections}', $2::jsonb, true) where id = $1`,
      [
        toolId,
        JSON.stringify({ "conn-1": { cursor: CURSOR, proposalId: "prop-1" } }),
      ]
    );

    await applyTemplateToExistingTool(
      drizzle(client) as never,
      toolId,
      {
        name: "google",
        description: "Google",
        config: { region: "us", timeoutSeconds: 30 },
        metadata: {
          sync: {
            enabled: true,
            kinds: {
              event: { enabled: true, windowDays: 90 },
              contact: { enabled: true, windowDays: 90 },
            },
          },
        },
      },
      "nango://google",
      []
    );

    const { rows } = await client.query<{
      config: Record<string, unknown>;
      metadata: { sync: { kinds: Record<string, Record<string, unknown>> } };
    }>(`select config, metadata from tools where id = $1`, [toolId]);
    const kinds = rows[0]!.metadata.sync.kinds;

    expect(JSON.stringify(before[0]!.metadata)).not.toContain(CURSOR);
    expect(kinds.event!.connections).toEqual({
      "conn-1": { cursor: CURSOR, proposalId: "prop-1" },
    });
    expect(kinds.event!.enabled).toBe(false);
    expect(kinds.event!.windowDays).toBe(90);
    expect(kinds.contact).toEqual({ enabled: true, windowDays: 90 });
    expect(rows[0]!.config).toEqual({ region: "eu", timeoutSeconds: 30 });
  });
});
