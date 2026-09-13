/**
 * "Make it a rule" — `guidelines.recordCorrection`, driven through the REAL
 * procedure on PGlite.
 *
 * Real: the procedure (visibility floor, uniform NOT_FOUND, scope authority,
 * the human/agent split), `assertProposalVisibleTo`, `isPodAdmin`,
 * `recordCorrectionAsGuideline` → the guideline store (create / supersede),
 * `proposeCorrectionAsGuideline` → `insertPendingProposal`, and the approve half
 * `applyStructureGuidelineApproval` on the proposal the agent filed. Tables are
 * generated from the Drizzle definitions (defaults included), so every column
 * the doors write exists.
 *
 * Stubbed, and why:
 *  - `emitSideEffects` — realtime/notification fan-out with its own suites
 *    (importOriginal + spread, never a total mock).
 *  - `isPodReadOnly` — the split-brain guard every mutation passes; it reads the
 *    sync-generation table, which is not modelled here. Pinned to "writable".
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

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
      schema: {
        proposals: schema.proposals,
        configSettings: schema.configSettings,
        workspaces: schema.workspaces,
        workspaceMembers: schema.workspaceMembers,
        users: schema.users,
      } as never,
    }),
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db } from "@synap/database";
import {
  proposals,
  configSettings,
  workspaces,
  workspaceMembers,
  users,
} from "@synap/database/schema";
import { guidelinesRouter } from "./guidelines.js";
import { applyStructureGuidelineApproval } from "../services/guidelines/guideline-versions.js";

const USER = "user-1";
const OTHER = "user-2";
const AGENT = "agent-1";
const WS = randomUUID();
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** The column's DEFAULT, so a door that omits `id` / `created_at` still inserts. */
function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const callerFor = (userId: string, agentUserId?: string) =>
  guidelinesRouter.createCaller({
    db,
    authenticated: true,
    userId,
    ...(agentUserId ? { agentUserId } : {}),
  } as never);

/** A pending capture proposal — pod-wide ones are the proposer's (`data.sourceId`). */
async function proposal(opts: {
  sourceId: string;
  workspaceId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, workspace_id, created_at, updated_at)
     values ($1, 'rejected', 'capture.graph', 'entity', $2, $3::jsonb, $4, $5, now(), now())`,
    [
      id,
      randomUUID(),
      JSON.stringify({ sourceId: opts.sourceId }),
      opts.sourceId,
      opts.workspaceId ?? null,
    ]
  );
  return id;
}

async function member(userId: string, role: string) {
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
    [randomUUID(), WS, userId, role]
  );
}

async function guidelineRows() {
  const { rows } = await q<{
    id: string;
    text: string;
    version: number;
    supersedes_id: string | null;
    workspace_id: string | null;
    created_by: string;
    source: string;
    scope_kind: string;
    revoked: boolean;
  }>(
    `select id, value->>'text' as text, version, supersedes_id, workspace_id, created_by,
       source, scope_kind, revoked_at is not null as revoked
     from config_settings where key = 'guideline' order by version`
  );
  return rows;
}

async function countProposals(type: string) {
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from proposals where proposal_type = $1`,
    [type]
  );
  return rows[0]!.n;
}

describe("guidelines.recordCorrection — make a correction a rule", () => {
  beforeAll(async () => {
    for (const t of [
      proposals,
      configSettings,
      workspaces,
      workspaceMembers,
      users,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from proposals; delete from config_settings; delete from workspace_members; delete from workspaces; delete from users;"
    );
  });

  it("a human's personal rule is written NOW as a version, and a second one supersedes it", async () => {
    const id = await proposal({ sourceId: USER });

    const first = await callerFor(USER).recordCorrection({
      proposalId: id,
      text: "  Screenshots of tweets are bookmarks.  ",
      scope: "personal",
    });
    expect(first).toMatchObject({ status: "saved", supersededId: null });
    expect(await guidelineRows()).toEqual([
      expect.objectContaining({
        text: "Screenshots of tweets are bookmarks.",
        version: 1,
        workspace_id: null,
        created_by: USER,
        source: `correction:${id}`,
        scope_kind: "default",
        revoked: false,
      }),
    ]);

    const second = await callerFor(USER).recordCorrection({
      proposalId: id,
      text: "Never invent a company.",
      scope: "personal",
    });
    const rows = await guidelineRows();
    expect(second).toMatchObject({
      status: "saved",
      supersededId: rows[0]!.id,
    });
    expect(rows).toEqual([
      expect.objectContaining({ version: 1, revoked: true }),
      expect.objectContaining({
        version: 2,
        supersedes_id: rows[0]!.id,
        text: "Screenshots of tweets are bookmarks.\n\nNever invent a company.",
        revoked: false,
      }),
    ]);
    expect(await countProposals("governance.structure_guideline")).toBe(0);
  });

  it("a workspace rule lands on the proposal's workspace for an editor", async () => {
    await member(USER, "editor");
    const id = await proposal({ sourceId: AGENT, workspaceId: WS });

    await expect(
      callerFor(USER).recordCorrection({
        proposalId: id,
        text: "Invoices are documents, not tasks.",
        scope: "workspace",
      })
    ).resolves.toMatchObject({ status: "saved" });
    expect(await guidelineRows()).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        created_by: USER,
        version: 1,
      }),
    ]);
  });

  it("an AGENT caller never writes a guideline: it files ONE structure-guideline proposal for its human, and approving it writes the version", async () => {
    const id = await proposal({ sourceId: USER });

    const out = await callerFor(USER, AGENT).recordCorrection({
      proposalId: id,
      text: "Screenshots of tweets are bookmarks.",
      scope: "personal",
    });
    expect(out).toMatchObject({ status: "proposed" });
    const proposalId = (out as { proposalId: string }).proposalId;
    expect(await guidelineRows()).toEqual([]);

    const { rows } = await q<{
      status: string;
      target_type: string;
      subject_user_id: string;
      agent_user_id: string;
      data: Record<string, unknown>;
    }>(
      `select status, target_type, subject_user_id, agent_user_id, data from proposals
       where proposal_type = 'governance.structure_guideline'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending",
      target_type: "governance",
      subject_user_id: USER,
      agent_user_id: AGENT,
    });
    expect(rows[0]!.data).toMatchObject({
      userId: USER,
      sourceId: USER,
      scopeKind: "default",
      workspaceId: null,
      text: "Screenshots of tweets are bookmarks.",
      addition: "Screenshots of tweets are bookmarks.",
      supersedesGuidelineId: null,
      evidence: { corrections: 1, proposals: 1, sampleProposalIds: [id] },
    });
    expect(rows[0]!.data.evidence).not.toHaveProperty("windowDays");

    // The approve half accepts the payload the door filed (sufficiency, not
    // just registration): the version is written AS the subject.
    const outcome = await applyStructureGuidelineApproval({
      proposalId,
      subjectUserId: USER,
      payload: rows[0]!.data,
    });
    expect(outcome.kind).toBe("applied");
    expect(await guidelineRows()).toEqual([
      expect.objectContaining({
        created_by: USER,
        source: `proposal:${proposalId}`,
        version: 1,
      }),
    ]);
  });

  it("a repeat AGENT ask answers the proposal already pending instead of filing another; a decided one does not block a new ask", async () => {
    const id = await proposal({ sourceId: USER });
    const ask = (text: string) =>
      callerFor(USER, AGENT).recordCorrection({
        proposalId: id,
        text,
        scope: "personal",
      });

    const first = await ask("Screenshots of tweets are bookmarks.");
    expect(first).toMatchObject({ status: "proposed", alreadyProposed: false });
    const second = await ask("Never invent a company.");
    expect(second).toMatchObject({
      status: "proposed",
      alreadyProposed: true,
      proposalId: (first as { proposalId: string }).proposalId,
    });
    expect(await countProposals("governance.structure_guideline")).toBe(1);

    await q(`update proposals set status = 'rejected' where id = $1`, [
      (first as { proposalId: string }).proposalId,
    ]);
    const third = await ask("Never invent a company.");
    expect(third).toMatchObject({ status: "proposed", alreadyProposed: false });
    expect(await countProposals("governance.structure_guideline")).toBe(2);
  });

  it("a VIEWER's agent cannot file a workspace rule the owner floor would refuse", async () => {
    // LIMIT, measured: today the visibility floor refuses first — a workspace
    // proposal needs owner/admin/editor to be SEEN, the same set the approve
    // floor requires — so this outcome holds with or without the explicit
    // `assertCanApproveStructureGuideline` on the agent path (negative control
    // stayed green). That call is kept so the agent path does not depend on
    // visibility staying as strict as authority.
    await member(USER, "viewer");
    const id = await proposal({ sourceId: USER, workspaceId: WS });

    await expect(
      callerFor(USER, AGENT).recordCorrection({
        proposalId: id,
        text: "Invoices are documents, not tasks.",
        scope: "workspace",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await countProposals("governance.structure_guideline")).toBe(0);
    expect(await guidelineRows()).toEqual([]);
  });

  it("a proposal the caller cannot see answers the SAME NOT_FOUND as one that does not exist, and writes nothing", async () => {
    const othersPodWide = await proposal({ sourceId: OTHER });
    const foreignWorkspace = await proposal({
      sourceId: OTHER,
      workspaceId: WS,
    });
    await member(USER, "viewer");

    const refusals = [];
    for (const proposalId of [othersPodWide, foreignWorkspace, randomUUID()]) {
      for (const caller of [callerFor(USER), callerFor(USER, AGENT)]) {
        const err = await caller
          .recordCorrection({ proposalId, text: "x", scope: "personal" })
          .then(
            () => null,
            (e: { code?: string; message?: string }) => e
          );
        refusals.push({ code: err?.code, message: err?.message });
      }
    }
    expect(refusals).toHaveLength(6);
    for (const refusal of refusals) {
      expect(refusal).toEqual({
        code: "NOT_FOUND",
        message: "Proposal not found",
      });
    }
    expect(await guidelineRows()).toEqual([]);
    expect(await countProposals("governance.structure_guideline")).toBe(0);
  });

  it("a workspace rule on a pod-wide proposal is refused, not silently made personal", async () => {
    const id = await proposal({ sourceId: USER });
    await expect(
      callerFor(USER).recordCorrection({
        proposalId: id,
        text: "x",
        scope: "workspace",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await guidelineRows()).toEqual([]);
  });
});
