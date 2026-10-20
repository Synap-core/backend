/**
 * `diagnose({ id: <playbook> })` names the skills a run of it would be refused
 * on — the SAME detection the run doors use (`findUnenabledPlaybookSkills`,
 * D3) — grouped by pack, with the capability card where a person enables it.
 *
 * Real SQL on PGlite, driven through the real door (`diagnoseRouter` →
 * `resolveObjectKind` → the playbook arm → `readPlaybookSkillReadiness` →
 * `findUnenabledPlaybookSkills` + `loadContainerRefs`). Nothing hand-built
 * between the rows and the report.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: undefined as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client);
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { diagnoseRouter } from "../index.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const PB = "33333333-3333-4333-8333-333333333333";
const SKILL_OFF = "44444444-4444-4444-8444-444444444444";
const SKILL_ON = "55555555-5555-4555-8555-555555555555";
const PACK = "66666666-6666-4666-8666-666666666666";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
  await q(
    "insert into workspaces (id, owner_id, name) values ($1, $2, 'Research')",
    [WS, USER]
  );
  await q(
    "insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')",
    [WS, USER]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template)
     values ($1, $2, $3, 'Research a Question', 'GATHER: use the source-triage skill. WEIGH: use the evidence-synthesis skill.')`,
    [PB, WS, USER]
  );
  await q(
    `insert into skills (id, name, scope, status, approved) values
       ($1, 'source-triage', 'pod', 'active', false),
       ($2, 'evidence-synthesis', 'pod', 'active', true)`,
    [SKILL_OFF, SKILL_ON]
  );
  await q(
    "insert into capabilities (id, name, workspace_id) values ($1, 'Research — Method Skills', null)",
    [PACK]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, workspace_id, created_at)
     values (gen_random_uuid(), 'skill', $1, 'capability', $2, 'member_of', null, now())`,
    [SKILL_OFF, PACK]
  );
}, 120_000);

describe("diagnose(playbook) — skill readiness", () => {
  it("names the skill that is off, its pack, and the card that enables it", async () => {
    const out = (await diagnoseRouter({ userId: USER, id: PB })) as {
      kind: string;
      summary: string;
      why: { skillReadiness: Record<string, unknown> };
    };
    expect(out.kind).toBe("playbook");
    expect(out.summary).toBe(
      'Playbook "Research a Question" cannot run: it uses skills that are not enabled yet (source-triage)'
    );
    expect(out.why.skillReadiness).toEqual({
      status: "ok",
      ready: false,
      disabled: [
        {
          pack: { id: PACK, name: "Research — Method Skills" },
          skills: [{ id: SKILL_OFF, name: "source-triage" }],
          enableLink: expect.stringMatching(
            new RegExp(`/open/capability/${PACK}$`)
          ),
        },
      ],
    });
  });

  it("says ready once the skill is on", async () => {
    await q("update skills set approved = true where id = $1", [SKILL_OFF]);
    const out = (await diagnoseRouter({ userId: USER, id: PB })) as {
      summary: string;
      why: { skillReadiness: Record<string, unknown> };
    };
    expect(out.summary).toBe('Playbook "Research a Question"');
    expect(out.why.skillReadiness).toEqual({
      status: "ok",
      ready: true,
      disabled: [],
    });
  });
});
