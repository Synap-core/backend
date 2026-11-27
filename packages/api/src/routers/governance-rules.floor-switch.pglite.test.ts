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
 * on (a structure write cannot be undone, so it never widens there).
 *
 * Not pinned here: the matrix's floor column (it shows at most four floor
 * kinds, so whether the kinds floor is among them depends on that cap) and
 * the next-rung offer (no switchable write is reversible, so no card can
 * tell the yield apart).
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
import { resolveAgentGovernanceDecision } from "@synap/database/agent-governance";
import * as schema from "@synap/database/schema";
import {
  AGENT_BUILDS_STRUCTURE_EVENT_KEYS,
  AGENT_SCHEMA_DEFINITION_EVENT_KEYS,
  floorClassOf,
} from "@synap/governance-policy";
import { governanceRulesRouter } from "./governance-rules.js";
import { draftMatrixWiden } from "../services/governance/widen-cell.js";
import type { Context } from "../types/context.js";

const ALICE = "alice-fs"; // the person, a pod admin
const AGENT = "agent-fs"; // an AI of Alice's
const STRUCTURE = "@agent-builds-structure";

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

  it("switched on, the same rule is stored", async () => {
    await caller(ALICE).setPodFloorDefault({
      pattern: STRUCTURE,
      enabled: true,
    });
    await expect(agentAuto("automation.create")).resolves.toBeTruthy();
  });

  it("and that rule decides the agent's write; the family's other writes still need theirs", async () => {
    await caller(ALICE).setPodFloorDefault({
      pattern: STRUCTURE,
      enabled: true,
    });
    await agentAuto("automation.create");
    expect(await decide("create")).toMatchObject({ decision: "execute" });
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
});

describe("the governance numbers, through their door", () => {
  const HOURS = "governance.own_work_fresh_hours" as const;

  it("an out-of-range value is a BAD_REQUEST, never a 500; an in-range one is stored", async () => {
    const err = await refusal(
      caller(ALICE).setPodSetting({ key: HOURS, value: 169 })
    );
    expect(err.code).toBe("BAD_REQUEST");
    await expect(
      caller(ALICE).setPodSetting({ key: HOURS, value: 48 })
    ).resolves.toEqual({ value: 48 });
  });

  it("the read lists each setting with its value, range and switch", async () => {
    const read = await caller(ALICE).podFloorDefaults();
    const hours = read.settings.find((s) => s.key === HOURS);
    expect(hours).toMatchObject({
      min: 1,
      max: 168,
      parameterOf: "@own-organise",
    });
    expect(typeof hours?.value).toBe("number");
    expect(read.settings.map((s) => s.key)).toContain(
      "governance.project_evidence_min"
    );
  });
});

describe("the platform floors name the switch that lifts them", () => {
  it("the structure floor is split: the switch lifts exactly its writes, the rest names no switch", async () => {
    const { alwaysPropose } = await caller(ALICE).platformDefaults();
    const builds = alwaysPropose.find((e) => e.key === "agent-builds-structure");
    expect(builds?.switchedBy).toBe("@agent-builds-structure");
    expect([...(builds?.actions ?? [])].sort()).toEqual(
      [...AGENT_BUILDS_STRUCTURE_EVENT_KEYS].sort()
    );
    const rest = alwaysPropose.find((e) => e.key === "agent-structure");
    expect(rest?.switchedBy).toBeUndefined();
    expect(rest?.actions).toEqual(
      expect.arrayContaining([
        "playbook.update",
        "automation.update",
        "cell.create",
        "profile.renderer.set",
      ])
    );
    for (const action of rest?.actions ?? []) {
      expect(AGENT_BUILDS_STRUCTURE_EVENT_KEYS, action).not.toContain(action);
    }
  });

  it("every switchable write sits in an entry its switch lifts; the rest name none", async () => {
    const { alwaysPropose } = await caller(ALICE).platformDefaults();
    for (const entry of alwaysPropose) {
      for (const action of entry.actions) {
        const family = floorClassOf(action);
        if (entry.key.startsWith("agent-")) {
          expect(entry.switchedBy ?? null, `${entry.key} ${action}`).toBe(
            family
          );
        }
      }
    }
    const lifted = alwaysPropose
      .filter((e) => e.switchedBy)
      .flatMap((e) => e.actions);
    for (const key of [
      ...AGENT_BUILDS_STRUCTURE_EVENT_KEYS,
      ...AGENT_SCHEMA_DEFINITION_EVENT_KEYS,
    ]) {
      expect(lifted, key).toContain(key);
    }
  });
});
