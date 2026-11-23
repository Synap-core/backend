/**
 * The floor switches through the person's own doors: the REAL
 * `governanceRules.setPodFloorDefault` and `governanceRules.create`, the REAL
 * rule store (PGlite) and the REAL resolver, then the doors that judge a key
 * by its floor (`draftMatrixWiden`, the agent matrix's floor column).
 *
 * Rows where a naive reading disagrees: the same `auto` rule refused while the
 * switch is off and stored once it is on (and only then deciding the agent's
 * write); a second row for a switch, refused (the switch reads one row); the
 * matrix widen, which stops at the floor while off and at reversibility once
 * on (a structure write cannot be undone, so it never widens there); the
 * floor column, which loses the kinds floor once that switch is on.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => userId === ALICE,
}));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import {
  readPodFloorsYield,
  resolveAgentGovernanceDecision,
} from "@synap/database";
import * as schema from "@synap/database/schema";
import { governanceRulesRouter } from "./governance-rules.js";
import { draftMatrixWiden } from "../services/governance/widen-cell.js";
import { floorProbes } from "../services/governance/agent-matrix.js";
import type { Context } from "../types/context.js";

const ALICE = "alice-fs"; // the person, a pod admin
const AGENT = "agent-fs"; // an AI of Alice's
const STRUCTURE = "@agent-builds-structure";
const KINDS = "@agent-defines-kinds";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const dflt =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "version"
          ? " default 1"
          : "";
    return `"${c.name}" ${type}${key}${dflt}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function caller(userId: string) {
  return governanceRulesRouter.createCaller({
    authenticated: true,
    userId,
  } as unknown as Context);
}

const agentAuto = (targetPattern: string) =>
  caller(ALICE).create({
    principalKind: "agent",
    agentUserId: AGENT,
    scopeKind: "pod",
    targetKind: "action",
    targetPattern,
    verdict: "auto",
  });

const decide = (action: string) =>
  resolveAgentGovernanceDecision({
    db: h.db as never,
    agentUserId: AGENT,
    workspaceId: null,
    subjectType: "automation",
    action,
    preferAgentMetadataAutoApproveFor: true,
  });

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; message?: string };
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_metadata) values ($1, $2, 'human', null, null), ($3, $4, 'agent', $1, '{}'::jsonb)`,
    [ALICE, `${ALICE}@x`, AGENT, `${AGENT}@x`]
  );
}, 120_000);

beforeEach(async () => {
  await q(`delete from governance_rules`);
});

describe("the floor switches, through the person's own doors", () => {
  it("off, the rule door refuses an auto rule on a floored write", async () => {
    const err = await refusal(agentAuto("automation.create"));
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toContain("NON_WIDENABLE_FLOOR");
  });

  it("switched on, the same rule is stored and decides the agent's write", async () => {
    expect(await decide("create")).toMatchObject({ decision: "propose" });
    await caller(ALICE).setPodFloorDefault({
      pattern: STRUCTURE,
      enabled: true,
    });
    await agentAuto("automation.create");
    expect(await decide("create")).toMatchObject({ decision: "execute" });
    // The rest of the family's writes still need their own rule.
    expect(await decide("activate")).toMatchObject({ decision: "propose" });
  });

  it("a second row for a switch is refused: the switch owns it", async () => {
    const err = await refusal(
      caller(ALICE).create({
        principalKind: "any",
        scopeKind: "pod",
        targetKind: "action",
        targetPattern: STRUCTURE,
        verdict: "auto",
      })
    );
    expect(err.code).toBe("BAD_REQUEST");
    expect(err.message).toContain("ROOT_SWITCH");
  });

  it("the matrix widen stops at the floor while off, at reversibility once on", async () => {
    const probe = {
      agentUserId: AGENT,
      workspaceId: null,
      action: "automation.create",
      profileSlug: null,
    };
    expect((await refusal(draftMatrixWiden(probe, ALICE))).message).toMatch(
      /a floor decides/
    );
    await caller(ALICE).setPodFloorDefault({
      pattern: STRUCTURE,
      enabled: true,
    });
    expect((await refusal(draftMatrixWiden(probe, ALICE))).message).toMatch(
      /cannot be undone/
    );
  });

  it("the matrix's floor column loses the kinds floor once that switch is on", async () => {
    const kindsFloor = async () =>
      floorProbes(await readPodFloorsYield(h.db as never)).some(
        (p) => p.action === "profile.create"
      );
    expect(await kindsFloor()).toBe(true);
    await caller(ALICE).setPodFloorDefault({ pattern: KINDS, enabled: true });
    expect(await kindsFloor()).toBe(false);
  });
});
