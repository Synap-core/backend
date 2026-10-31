/**
 * `toolCapabilityForReader` — the capability a tool opens on, for one reader.
 * PGlite: rows are INSERTed and a real engine answers, so the uuid/text join
 * cast and the visibility floor are exercised, not described.
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
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  capabilities,
  links,
  podMembers,
  projectMembers,
  users,
  workspaceMembers,
  workspaces,
} from "@synap/database/schema";
import { toolCapabilityForReader } from "./tool-capability.js";

type ColumnLike = {
  name: string;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** Minimal DDL from the REAL Drizzle config (as the runs lens tests). */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp with time zone|timestamp)$/.test(
        base
      )
        ? base
        : "text";
    let def = "";
    if (c.hasDefault) {
      const d = c.default;
      if (isArray) def = " default '{}'";
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const USER = "user-tool-capability";
const TOOL = randomUUID();
const TOOL_HIDDEN = randomUUID();
const TOOL_ALONE = randomUUID();
const CAP = randomUUID();
const CAP_HIDDEN = randomUUID();

beforeAll(async () => {
  for (const table of [
    workspaces,
    workspaceMembers,
    podMembers,
    users,
    projectMembers,
    capabilities,
    links,
  ]) {
    await h.client!.exec(ddlFor(table as unknown as PgTable));
  }
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  await h.client!.query(
    `insert into capabilities (id, name, workspace_id) values ($1, 'Gmail', null), ($2, 'Hidden', $3)`,
    [CAP, CAP_HIDDEN, randomUUID()]
  );
  await h.client!.query(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type)
     values (gen_random_uuid(), 'tool', $1, 'capability', $2, 'member_of'),
            (gen_random_uuid(), 'tool', $3, 'capability', $4, 'member_of'),
            (gen_random_uuid(), 'tool', $5, 'capability', $2, 'relates_to')`,
    [TOOL, CAP, TOOL_HIDDEN, CAP_HIDDEN, TOOL_ALONE]
  );
});

describe("toolCapabilityForReader", () => {
  it("a tool opens on the capability it is a member of", async () => {
    expect(await toolCapabilityForReader(USER, TOOL)).toBe(CAP);
  });

  it("a capability the reader cannot see is null, never its id", async () => {
    expect(await toolCapabilityForReader(USER, TOOL_HIDDEN)).toBeNull();
  });

  it("only a member_of edge counts", async () => {
    expect(await toolCapabilityForReader(USER, TOOL_ALONE)).toBeNull();
  });
});
