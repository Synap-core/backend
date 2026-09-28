/**
 * A PROPOSED `workspaces.setIntelligenceService` — approving it must apply the
 * chosen service (and a `null` reset must remove the pin).
 *
 * The defect: the gate filed `data: { id }` only. The row lands as
 * `workspace/update` (the gate's "workspaces" is singularised), whose executor
 * took the RENAME branch for a bare `{ id }` and replayed
 * `workspacesRouter.update({ id })` — the proposal flipped APPROVED and the
 * space stayed on whatever service it had.
 *
 * Driven end to end with nothing hand-built between the two halves: the REAL
 * procedure files the proposal (its gate `data` is captured verbatim and
 * stored in the request-shaped envelope `permission-check.ts` writes —
 * `{ ...request, data }`), then the REAL `workspace/update` executor replays it
 * as the approver through the REAL procedure → `WorkspaceRepository` → SQL on
 * PGlite. Stubbed: the permission gate itself (first call = proposer ⇒
 * proposed, later calls = approver ⇒ granted), the event append, audit log and
 * side-effect bus.
 *
 * What this CANNOT see: production Postgres constraints (PGlite tables are
 * generated from the Drizzle definitions without FKs/NOT NULL/enums), and the
 * real governance ladder deciding who proposes (it has its own tests).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  gateCalls: [] as Array<Record<string, unknown>>,
  proposeNext: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/permission-check.js")>()),
  checkPermissionOrPropose: async (args: Record<string, unknown>) => {
    h.gateCalls.push(args);
    if (h.proposeNext) {
      h.proposeNext = false;
      return { granted: false, proposalId: PROPOSAL };
    }
    return { granted: true };
  },
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => undefined }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  intelligenceServices,
  syncGeneration,
  proposals,
} from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";
import { proposalExecRegistry } from "./proposals/execution-registry.js";
import { registerWorkspaceExecutors } from "./proposals/executors/workspace.js";

const OWNER = "owner-1";
const WS = randomUUID();
const PROPOSAL = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const settingsOf = async () =>
  (
    await h.client!.query<{ settings: Record<string, unknown> }>(
      `select settings from workspaces where id = $1`,
      [WS]
    )
  ).rows[0]?.settings;

const caller = () =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: OWNER,
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

/**
 * File the proposal through the real procedure, then approve it through the
 * real executor the stored `targetType/changeType` resolves to.
 */
async function proposeThenApprove(serviceId: string | null) {
  h.gateCalls = [];
  h.proposeNext = true;
  const filed = await caller().setIntelligenceService({
    workspaceId: WS,
    serviceId,
  });
  expect(filed.status).toBe("proposed");

  const gate = h.gateCalls[0]!;
  // permission-check.ts: singularType = subjectType minus a trailing "s".
  const targetType = String(gate.subjectType).replace(/s$/, "");
  const key = `${targetType}/${String(gate.action)}`;
  expect(key).toBe("workspace/update");

  await h.client!.query(`delete from proposals where id = $1`, [PROPOSAL]);
  await h.client!.query(
    `insert into proposals (id, workspace_id, status) values ($1, $2, 'pending')`,
    [PROPOSAL, WS]
  );

  const exec = proposalExecRegistry.resolve(key);
  if (!exec) throw new Error(`no executor for ${key}`);
  const res = await exec.execute({
    proposal: {
      id: PROPOSAL,
      targetType,
      targetId: WS,
      proposalType: gate.action,
      workspaceId: WS,
      sessionId: null,
      projectId: null,
      agentUserId: null,
      subjectUserId: OWNER,
      sourceMessageId: null,
      data: { requestId: "r-1", targetType, data: gate.data },
    },
    payload: gate.data,
    userId: OWNER,
    input: { proposalId: PROPOSAL },
    ctx: {} as never,
    deps: {
      reportProposalOutcome: () => undefined,
      emitProposalReviewed: () => undefined,
    },
  } as never);
  return { filed, res };
}

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    intelligenceServices,
    syncGeneration,
    proposals,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'Builder', $2, '{"agentPersonality":"terse"}'::jsonb, now(), now())`,
    [WS, OWNER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );
  await h.client!.query(
    `insert into intelligence_services (id, service_id, name, status, enabled)
     values ($1, 'svc-house', 'House IS', 'active', true)`,
    [randomUUID()]
  );
  registerWorkspaceExecutors();
});

beforeEach(() => {
  h.proposeNext = false;
});

describe("approving a proposed setIntelligenceService applies it", () => {
  it("filing the proposal writes nothing; approving it pins the service", async () => {
    const before = await settingsOf();
    h.gateCalls = [];
    h.proposeNext = true;
    await caller().setIntelligenceService({
      workspaceId: WS,
      serviceId: "svc-house",
    });
    expect(await settingsOf()).toEqual(before);

    const { res } = await proposeThenApprove("svc-house");
    expect(res).toMatchObject({ success: true, primaryId: WS });
    expect(await settingsOf()).toEqual({
      agentPersonality: "terse",
      intelligenceServiceId: "svc-house",
    });
    const status = await h.client!.query<{ status: string }>(
      `select status from proposals where id = $1`,
      [PROPOSAL]
    );
    expect(status.rows[0]?.status).toBe("approved");
  });

  it("approving a null reset REMOVES the pin, keeping the rest", async () => {
    await caller().setIntelligenceService({
      workspaceId: WS,
      serviceId: "svc-house",
    });
    expect(await settingsOf()).toHaveProperty(
      "intelligenceServiceId",
      "svc-house"
    );

    const { res } = await proposeThenApprove(null);
    expect(res).toMatchObject({ success: true });
    const settings = await settingsOf();
    expect(settings).not.toHaveProperty("intelligenceServiceId");
    expect(settings).toEqual({ agentPersonality: "terse" });
  });
});
