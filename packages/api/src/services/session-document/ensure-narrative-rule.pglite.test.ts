/**
 * The D10 rule: seeded once, never resurrected after a revoke, and — through
 * the REAL resolver and engine — the only thing that turns the narrative key
 * into `execute`. Also pins that neither key is floor-class, so the rule is
 * honourable at all.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

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
  return {
    ...actual,
    db: drizzle(client, {
      schema: { governanceRules: schema.governanceRules } as never,
    }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db } from "@synap/database";
import { resolveGovernanceRule } from "@synap/database/agent-governance";
import { governanceRules } from "@synap/database/schema";
import {
  decideAgentPolicy,
  nonWidenableFloorFor,
} from "@synap/governance-policy";
import { ensureSessionNarrativeRule } from "./ensure-narrative-rule.js";
import {
  SECTION_UPDATE_ACTION,
  SESSION_NARRATIVE_ACTION,
  SESSION_NARRATIVE_EVENT_KEY,
} from "./governance-keys.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def = !c.hasDefault
      ? ""
      : type === "uuid"
        ? " default gen_random_uuid()"
        : type.startsWith("timestamp")
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function verdictFor(action: string, opts: { originTrust?: "untrusted" } = {}) {
  const rule = await resolveGovernanceRule({
    db: db as never,
    agentUserId: "agent-1",
    workspaceId: null,
    subjectType: "document",
    action,
  });
  return decideAgentPolicy({
    subjectType: "document",
    action,
    governanceRuleVerdict: rule?.verdict,
    // An agent whose metadata says every write proposes (rung 5) — the rule at
    // rung 2.8 sits above it, which is what makes D10 hold for such agents.
    writesRequireProposal: true,
    ...(opts.originTrust ? { originTrust: opts.originTrust } : {}),
  }).verdict;
}

beforeAll(async () => {
  await h.client!.exec(ddlFor(governanceRules as PgTable));
});

beforeEach(async () => {
  await q(`delete from governance_rules`);
});

describe("ensureSessionNarrativeRule", () => {
  it("seeds exactly one pod-wide auto rule for the narrative key, idempotently", async () => {
    expect(await ensureSessionNarrativeRule()).toEqual({ inserted: true });
    expect(await ensureSessionNarrativeRule()).toEqual({ inserted: false });
    const { rows } = await q<Record<string, string>>(
      `select principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by from governance_rules`
    );
    expect(rows).toEqual([
      {
        principal_kind: "any",
        scope_kind: "pod",
        target_kind: "action",
        target_pattern: SESSION_NARRATIVE_EVENT_KEY,
        verdict: "auto",
        created_by: "system:session-document",
      },
    ]);
  });

  it("never resurrects a rule a person revoked", async () => {
    await ensureSessionNarrativeRule();
    await q(`update governance_rules set revoked_at = now()`);
    expect(await ensureSessionNarrativeRule()).toEqual({ inserted: false });
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from governance_rules where revoked_at is null`
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe("the rule through the real resolver + engine", () => {
  it("neither key is floor-class — a rule can resolve both", () => {
    expect(nonWidenableFloorFor(`document.${SESSION_NARRATIVE_ACTION}`)).toBeNull();
    expect(nonWidenableFloorFor(`document.${SECTION_UPDATE_ACTION}`)).toBeNull();
  });

  it("without the rule, the narrative key PROPOSES", async () => {
    expect(await verdictFor(SESSION_NARRATIVE_ACTION)).toBe("propose");
  });

  it("with the seeded rule, the narrative key EXECUTES; the other key still PROPOSES", async () => {
    await ensureSessionNarrativeRule();
    expect(await verdictFor(SESSION_NARRATIVE_ACTION)).toBe("execute");
    expect(await verdictFor(SECTION_UPDATE_ACTION)).toBe("propose");
  });

  it("an untrusted origin still tightens the narrative key to a proposal (the rule never beats rung 2.55)", async () => {
    await ensureSessionNarrativeRule();
    expect(
      await verdictFor(SESSION_NARRATIVE_ACTION, { originTrust: "untrusted" })
    ).toBe("propose");
  });
});
