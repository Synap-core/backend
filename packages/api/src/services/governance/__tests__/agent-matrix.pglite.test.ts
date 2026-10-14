/**
 * THE AGENT × WORK MATRIX (`agent-matrix.ts`), read back out of PGlite:
 *   - every agent cell is EXACTLY the one resolver's dry run for that agent,
 *     space and probe (parity through the real reader — no hand-built cell);
 *   - columns are derived: one per process (a playbook with a subject kind),
 *     "Other work" per space, the locked floors; a playbook with no subject
 *     kind is not a process;
 *   - the floors outrank an agent's "auto everything" rule;
 *   - 'mine' is the caller's own agents; a computer is a group, never a row;
 *   - a collapsed group carries the sum of its members' splits.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
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
import * as database from "@synap/database";
import { dryRunAgentGovernanceDecision } from "@synap/database/agent-governance";
import { readAgentMatrix, floorProbes } from "../agent-matrix.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();
const OTHER = randomUUID();
const COMPUTER = randomUUID();
const CC = randomUUID();
const CODEX = randomUUID();
const THEIRS = randomUUID();
const SALES = randomUUID();
const OPS = randomUUID();
const PB_DEALS = randomUUID();
const PB_LOOSE = randomUUID();

beforeAll(async () => {
  const d = database as unknown as Record<string, PgTable>;
  for (const name of [
    "users",
    "workspaces",
    "workspaceMembers",
    "podMembers",
    "playbooks",
    "governanceRules",
    "governanceCeilings",
    "events",
    "entities",
    "apps",
    "projectMembers",
  ]) {
    await h.client!.exec(ddlFor(d[name]!));
  }
  await q(
    `insert into users (id, email, user_type) values ($1, 'o@x', 'human'), ($2, 'p@x', 'human')`,
    [OWNER, OTHER]
  );
  const agent = (id: string, type: string, owner: string, host: string | null, name: string) =>
    q(
      `insert into users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id) values ($1, $2, $3, 'agent', $4, $5, $6)`,
      [id, `${id}@x`, name, type, owner, host]
    );
  await agent(COMPUTER, "machine", OWNER, null, "Mac");
  await agent(CC, "claude-code", OWNER, COMPUTER, "Claude Code");
  await agent(CODEX, "codex", OWNER, null, "Codex");
  await agent(THEIRS, "claude-code", OTHER, null, "Their Claude");
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'Sales', $3, '{}'), ($2, 'Ops', $3, '{}')`,
    [SALES, OPS, OWNER]
  );
  await q(
    `insert into playbooks (id, name, workspace_id, subject_profile) values ($1, 'Work a deal', $3, $4::jsonb), ($2, 'Loose checklist', $3, null)`,
    [PB_DEALS, PB_LOOSE, SALES, JSON.stringify({ profileSlug: "deal", statusProperty: "stage" })]
  );
  const rule = (principal: string, agentId: string | null, pattern: string, verdict: string, ws: string | null) =>
    q(
      `insert into governance_rules (principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by) values ($1, $2, $3, $4, 'action', $5, $6, 'x')`,
      [principal, agentId, ws ? "workspace" : "pod", ws, pattern, verdict]
    );
  // Claude Code may do anything (the floors must still hold); Codex is
  // trusted on deals in Sales only; the pod default acts on reversible writes.
  await rule("agent", CC, "*", "auto", null);
  await rule("agent", CODEX, "entity.update", "auto", SALES);
  await rule("any", null, "@reversible", "auto", null);
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

describe("readAgentMatrix", () => {
  it("columns are derived from the pod: floors, each process, Other work per space", async () => {
    const m = await readAgentMatrix({ userId: OWNER, lens: "pod" });
    // Non-vacuity: several distinct floor kinds, each a real event key.
    expect(floorProbes().length).toBeGreaterThan(1);
    expect(floorProbes().every((p) => /^[\w-]+\.[\w.-]+$/.test(p.action))).toBe(true);
    expect(m.columns.map((c) => c.id)).toEqual([
      "floors",
      `other:${OPS}`,
      `process:${PB_DEALS}`,
      `other:${SALES}`,
    ]);
    const deals = m.columns.find((c) => c.id === `process:${PB_DEALS}`)!;
    expect(deals.probes.every((p) => p.profileSlug === "deal")).toBe(true);
    expect(m.partial).toBeNull();
  });

  it("every agent cell is the one resolver's dry run, probe by probe", async () => {
    const m = await readAgentMatrix({ userId: OWNER, lens: "pod" });
    let checked = 0;
    for (const g of m.groups)
      for (const c of g.computers)
        for (const a of c.agents)
          for (const col of m.columns) {
            const cell = a.cells[col.id]!;
            for (const [i, probe] of col.probes.entries()) {
              const direct = await dryRunAgentGovernanceDecision({
                db: database.db as never,
                userId: OWNER,
                agentUserId: a.agentUserId,
                workspaceId: col.workspaceId,
                action: probe.action,
                profileSlug: probe.profileSlug,
                door: "chat",
              });
              expect(cell.answers![i]).toMatchObject({
                probeKey: probe.key,
                rung: direct.rung,
                reason: direct.reason,
              });
              checked++;
            }
          }
    expect(checked).toBeGreaterThan(20); // non-vacuity
  });

  it("an 'auto everything' rule never widens the floors", async () => {
    const m = await readAgentMatrix({ userId: OWNER, lens: "pod" });
    const cc = m.groups
      .flatMap((g) => g.computers.flatMap((c) => c.agents))
      .find((a) => a.agentUserId === CC)!;
    expect(cc.cells["floors"]!.split.auto).toBe(0);
    // …while the same rule makes the process act.
    expect(cc.cells[`process:${PB_DEALS}`]!.split.auto).toBeGreaterThan(0);
  });

  it("'mine' is the caller's own agents; a computer groups, it is never a row", async () => {
    const m = await readAgentMatrix({ userId: OWNER, lens: "mine" });
    const ids = m.groups.flatMap((g) => g.computers.flatMap((c) => c.agents.map((a) => a.agentUserId)));
    expect(ids.sort()).toEqual([CC, CODEX].sort());
    const ccGroup = m.groups.find((g) => g.agentType === "claude-code")!;
    expect(ccGroup.computers.map((c) => [c.hostUserId, c.label])).toEqual([[COMPUTER, "Mac"]]);
  });

  it("a group's cell is the sum of its members' splits", async () => {
    const m = await readAgentMatrix({ userId: OWNER, lens: "pod" });
    const cc = m.groups.find((g) => g.agentType === "claude-code")!;
    for (const col of m.columns) {
      const members = cc.computers.flatMap((c) => c.agents).map((a) => a.cells[col.id]!.split);
      const sum = members.reduce(
        (s, x) => ({ auto: s.auto + x.auto, ask: s.ask + x.ask, off: s.off + x.off }),
        { auto: 0, ask: 0, off: 0 }
      );
      expect(cc.cells[col.id]!.split).toEqual(sum);
    }
  });
});
