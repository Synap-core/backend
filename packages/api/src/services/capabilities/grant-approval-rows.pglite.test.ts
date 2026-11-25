/**
 * The approval rows a session pre-approval writes and a grant revoke takes
 * back (decision D2: a grant means "may use"; the row is the "without
 * asking"), through the doors every rule writer goes through: an auto row for
 * one agent is copied onto that agent's own box (host-seed.ts), and revoking
 * it takes the copy back. A row for anyone has no copy. Writing twice writes
 * once.
 *
 * Real Postgres (PGlite), minimal DDL derived from the Drizzle tables.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { governanceRules, users } from "@synap/database/schema";
import {
  revokeGrantApprovalRows,
  writeSessionGrantApprovalRows,
} from "./grant-approval-rows.js";

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

const OWNER = "o0000000-0000-4000-8000-000000000001";
const AGENT = "a0000000-0000-4000-8000-000000000001";
const BOX = "b0000000-0000-4000-8000-000000000001";
const WS = "11111111-1111-4111-8111-111111111111";
const TOOL = "70000000-0000-4000-8000-000000000001";
const SESSION = "80000000-0000-4000-8000-000000000001";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [users, governanceRules]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  // The agent runs on its own box: a computer that belongs to an agent and
  // has the agent's owner (host-seed.ts `seedsOntoHost`).
  await pg.exec(`
    insert into users (id, email, created_by_user_id, agent_type, host_user_id, computer_belongs_to)
    values ('${OWNER}', 'o@x', null, null, null, null),
           ('${BOX}', 'b@x', '${OWNER}', 'machine', null, 'agent'),
           ('${AGENT}', 'a@x', '${OWNER}', 'assistant', '${BOX}', null);
  `);
  db = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

async function activeRows() {
  const { rows } = await pg.query<{
    principal_kind: string;
    agent_user_id: string | null;
    target_pattern: string;
    verdict: string;
    created_by: string;
  }>(
    `select principal_kind, agent_user_id, target_pattern, verdict, created_by
       from governance_rules where revoked_at is null order by created_by`
  );
  return rows;
}

describe("session pre-approval rows (D2) keep the host seed", () => {
  it("an agent's auto row is written once, with its copy on the agent's own box", async () => {
    const input = {
      grantedTo: AGENT,
      workspaceId: WS,
      sessionId: SESSION,
      partIds: [TOOL],
    };
    await writeSessionGrantApprovalRows(db, input);
    await writeSessionGrantApprovalRows(db, input);
    const rows = await activeRows();
    expect(rows).toHaveLength(2);
    const agentRow = rows.find((r) => r.agent_user_id === AGENT)!;
    expect(agentRow).toMatchObject({
      principal_kind: "agent",
      target_pattern: TOOL,
      verdict: "auto",
      created_by: `system:session-grant:${SESSION}`,
    });
    const seed = rows.find((r) => r.agent_user_id === BOX)!;
    expect(seed.verdict).toBe("auto");
    expect(seed.target_pattern).toBe(TOOL);
    expect(seed.created_by.startsWith("system:host-seed:")).toBe(true);
  });

  it("revoking the grant takes the row and its copy back", async () => {
    await revokeGrantApprovalRows(db, [
      { grantedTo: AGENT, workspaceId: WS, grantableId: TOOL },
    ]);
    expect(await activeRows()).toEqual([]);
  });

  it("a pre-approval for anyone has no copy", async () => {
    await writeSessionGrantApprovalRows(db, {
      grantedTo: null,
      workspaceId: WS,
      sessionId: SESSION,
      partIds: [TOOL],
    });
    const rows = await activeRows();
    expect(rows).toEqual([
      expect.objectContaining({
        principal_kind: "any",
        agent_user_id: null,
        verdict: "auto",
      }),
    ]);
  });
});
