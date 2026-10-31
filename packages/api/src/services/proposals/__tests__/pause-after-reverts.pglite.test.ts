/**
 * PAUSE AFTER REVERTS (S3, founder Q3): an earned grant pauses when 2 receipts
 * it decided are undone within 30 days. On PGlite, tables from their drizzle
 * definitions.
 *
 * Real: `pauseEarnedRuleAfterReverts` (the revert door's call) and
 * `pauseEarnedRulesAfterReverts` (the daily tighten pass's backstop), reading
 * receipts by their `_autoApprove.governanceRuleId` and soft-revoking the rule.
 *
 * Hand-built, and why: the receipt rows, in the shape the revert door leaves
 * (status `reverted`, `data.revertedAt`; or reopened to `pending` with
 * `revertedAt` kept). The door itself is driven in
 * `auto-approved-create-undo.pglite.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual, getDb: async () => holder.db };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals, governanceRules } from "@synap/database";
import { RULE_PAUSED_AFTER_REVERTS } from "@synap-core/types/trust-ladder";
import {
  pauseEarnedRuleAfterReverts,
  pauseEarnedRulesAfterReverts,
} from "../recommend-tighten.js";

const AGENT = "agent-1";
const NOW = new Date("2026-10-30T12:00:00.000Z");
const DAY = 86_400_000;

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

let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  for (const table of [proposals, governanceRules]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  holder.db = drizzle(client, { schema: { proposals, governanceRules } });
});

async function rule(
  o: { earned?: boolean; revokedAt?: Date } = {}
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, target_profile, verdict, source_proposal_id, created_by, revoked_at)
     values ($1, 'agent', $2, 'pod', 'action', 'entity.create', 'note', 'auto', $3, 'user:owner', $4)`,
    [
      id,
      AGENT,
      o.earned === false ? null : randomUUID(),
      o.revokedAt?.toISOString() ?? null,
    ]
  );
  return id;
}

/** A receipt the rule decided, undone `daysAgo` before NOW (or never). */
async function receipt(
  ruleId: string,
  o: { revertedDaysAgo?: number; reopened?: boolean } = {}
): Promise<string> {
  const id = randomUUID();
  const reverted = o.revertedDaysAgo !== undefined;
  const at = reverted
    ? new Date(NOW.getTime() - o.revertedDaysAgo! * DAY)
    : null;
  const status = !reverted
    ? "auto_approved"
    : o.reopened
      ? "pending"
      : "reverted";
  await client.query(
    `insert into proposals (id, workspace_id, status, proposal_type, target_type, target_id, data, created_by, agent_user_id, reviewed_at)
     values ($1, null, $2, 'entity.create', 'entity', $3, $4::jsonb, $5, $5, $6)`,
    [
      id,
      status,
      randomUUID(),
      JSON.stringify({
        profileSlug: "note",
        _autoApprove: {
          approvedBy: "system:auto_approve",
          governanceRuleId: ruleId,
        },
        ...(at ? { revertedAt: at.toISOString() } : {}),
      }),
      AGENT,
      at && !o.reopened ? at.toISOString() : null,
    ]
  );
  return id;
}

async function state(id: string) {
  return (
    await client.query<{
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>(
      `select revoked_at, revoked_reason from governance_rules where id = $1`,
      [id]
    )
  ).rows[0]!;
}

describe("pauseEarnedRuleAfterReverts", () => {
  it("two undone receipts within 30 days pause the earned rule, with its reason", async () => {
    const id = await rule();
    await receipt(id, { revertedDaysAgo: 1 });
    await receipt(id, { revertedDaysAgo: 29 });
    await receipt(id); // still standing: not an undo
    expect(await pauseEarnedRuleAfterReverts(id, NOW)).toBe(true);
    const s = await state(id);
    expect(s.revoked_at).not.toBeNull();
    expect(s.revoked_reason).toBe(RULE_PAUSED_AFTER_REVERTS);
  });

  it("one undo does not pause it", async () => {
    const id = await rule();
    await receipt(id, { revertedDaysAgo: 1 });
    await receipt(id);
    expect(await pauseEarnedRuleAfterReverts(id, NOW)).toBe(false);
    expect(await state(id)).toEqual({ revoked_at: null, revoked_reason: null });
  });

  it("an undo older than 30 days is outside the window", async () => {
    const id = await rule();
    await receipt(id, { revertedDaysAgo: 1 });
    await receipt(id, { revertedDaysAgo: 31 });
    expect(await pauseEarnedRuleAfterReverts(id, NOW)).toBe(false);
    expect((await state(id)).revoked_at).toBeNull();
  });

  it("a reverted-then-reopened receipt is still an undo", async () => {
    const id = await rule();
    await receipt(id, { revertedDaysAgo: 2 });
    await receipt(id, { revertedDaysAgo: 3, reopened: true });
    expect(await pauseEarnedRuleAfterReverts(id, NOW)).toBe(true);
  });

  it("never touches a rule a person wrote at the editor, or one already revoked", async () => {
    const authored = await rule({ earned: false });
    await receipt(authored, { revertedDaysAgo: 1 });
    await receipt(authored, { revertedDaysAgo: 2 });
    expect(await pauseEarnedRuleAfterReverts(authored, NOW)).toBe(false);
    expect((await state(authored)).revoked_at).toBeNull();

    const revokedAt = new Date(NOW.getTime() - 5 * DAY);
    const gone = await rule({ revokedAt });
    await receipt(gone, { revertedDaysAgo: 1 });
    await receipt(gone, { revertedDaysAgo: 2 });
    expect(await pauseEarnedRuleAfterReverts(gone, NOW)).toBe(false);
    const s = await state(gone);
    expect(s.revoked_at!.toISOString()).toBe(revokedAt.toISOString());
    expect(s.revoked_reason).toBeNull();
  });
});

describe("pauseEarnedRulesAfterReverts — the daily backstop", () => {
  it("pauses every earned rule over the bar, and only those", async () => {
    const over = await rule();
    await receipt(over, { revertedDaysAgo: 1 });
    await receipt(over, { revertedDaysAgo: 4 });
    const under = await rule();
    await receipt(under, { revertedDaysAgo: 1 });
    expect(await pauseEarnedRulesAfterReverts(NOW)).toBe(1);
    expect((await state(over)).revoked_reason).toBe(RULE_PAUSED_AFTER_REVERTS);
    expect((await state(under)).revoked_at).toBeNull();
    // Idempotent: a paused rule is not paused again.
    expect(await pauseEarnedRulesAfterReverts(NOW)).toBe(0);
  });
});
