/**
 * The receipt read-back's OWNER FLOOR — driven through the REAL query on
 * PGlite (tables generated from the Drizzle definitions).
 *
 * `proposals.createdBy` is overloaded: it holds the userId OR the agentUserId
 * that filed the row. A floor of `createdBy = caller` therefore misses a row the
 * caller's own agent filed with its id in `createdBy` — and the receipt would
 * report `proposal-not-found` for a proposal this very call just wrote.
 *
 * The floor is `authoredByUser` (me, or an agent I created) OR
 * `subjectUserId = me`. Each fixture row is admitted by exactly ONE branch, so
 * removing any branch fails exactly its row:
 *   - agent row, agent id in `createdBy` only        → lineage branch
 *   - pod-seeded agent (not mine) with owner = human → `subjectUserId` branch
 *   - another human's agent row                      → must stay unreadable
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

// The lineage subquery (`ownAgentUserIds`) is built on the module `db`; swap it
// for the PGlite drizzle so the whole predicate runs on one connection.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, {
    schema: { proposals: schema.proposals, users: schema.users } as never,
  });
  return { ...actual, db: h.db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals, users } from "@synap/database/schema";
import { readStoredProposalScope } from "./stored-capture-scope.js";

type ColumnLike = {
  name: string;
  primary: boolean;
  getSQLType(): string;
};

/** Loose DDL: column names + base types only (no constraints, no defaults). */
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
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const HUMAN = "user-human";
const MY_AGENT = "agent-mine";
const SEEDED_AGENT = "agent-seeded";
const OTHER_HUMAN = "user-other";
const OTHER_AGENT = "agent-other";

const P_MY_AGENT = randomUUID();
const P_SEEDED = randomUUID();
const P_OTHER = randomUUID();
const P_HUMAN = randomUUID();
const PROJECT = randomUUID();
const SESSION = randomUUID();

async function seedUser(
  id: string,
  userType: string,
  createdByUserId: string | null
) {
  await h.client!.query(
    `insert into users (id, email, name, user_type, created_by_user_id) values ($1,$2,$3,$4,$5)`,
    [id, `${id}@synap.test`, id, userType, createdByUserId]
  );
}

async function seedProposal(row: {
  id: string;
  createdBy: string;
  agentUserId: string | null;
  subjectUserId: string | null;
}) {
  await h.client!.query(
    `insert into proposals (id, created_by, agent_user_id, subject_user_id, project_id, session_id, workspace_id, proposal_type, target_type, target_id, status, data)
     values ($1,$2,$3,$4,$5,$6,null,'capture.graph','entity',$7,'pending','{}'::jsonb)`,
    [
      row.id,
      row.createdBy,
      row.agentUserId,
      row.subjectUserId,
      PROJECT,
      SESSION,
      randomUUID(),
    ]
  );
}

beforeAll(async () => {
  await h.client!.exec(ddlFor(users));
  await h.client!.exec(ddlFor(proposals));
  await seedUser(HUMAN, "human", null);
  await seedUser(MY_AGENT, "agent", HUMAN);
  await seedUser(SEEDED_AGENT, "agent", null);
  await seedUser(OTHER_HUMAN, "human", null);
  await seedUser(OTHER_AGENT, "agent", OTHER_HUMAN);
  // Filed by my agent through a door that put the AGENT in `createdBy` and set
  // neither `agentUserId` nor the owner column: ONLY the lineage admits it.
  await seedProposal({
    id: P_MY_AGENT,
    createdBy: MY_AGENT,
    agentUserId: null,
    subjectUserId: null,
  });
  // A pod-seeded agent this human did not create, owner floor = this human:
  // ONLY `subjectUserId` admits it.
  await seedProposal({
    id: P_SEEDED,
    createdBy: SEEDED_AGENT,
    agentUserId: SEEDED_AGENT,
    subjectUserId: HUMAN,
  });
  await seedProposal({
    id: P_OTHER,
    createdBy: OTHER_AGENT,
    agentUserId: OTHER_AGENT,
    subjectUserId: OTHER_HUMAN,
  });
  await seedProposal({
    id: P_HUMAN,
    createdBy: HUMAN,
    agentUserId: null,
    subjectUserId: HUMAN,
  });
});

const read = (userId: string, proposalIds: string[]) =>
  readStoredProposalScope(h.db as never, { userId, proposalIds });

describe("readStoredProposalScope — owner floor on the real query", () => {
  it("reads a row my AGENT filed with its own id in createdBy (lineage branch)", async () => {
    const out = await read(HUMAN, [P_MY_AGENT]);
    expect(out).toEqual({
      status: "read",
      scope: { workspaceId: null, projectId: PROJECT, sessionId: SESSION },
    });
  });

  it("reads a pod-seeded agent's row whose owner floor names me (subjectUserId branch)", async () => {
    const out = await read(HUMAN, [P_SEEDED]);
    expect(out.status).toBe("read");
  });

  it("reads a row I authored directly", async () => {
    expect((await read(HUMAN, [P_HUMAN])).status).toBe("read");
  });

  it("never reads another human's agent row (no widening)", async () => {
    expect(await read(HUMAN, [P_OTHER])).toEqual({
      status: "unavailable",
      reason: "proposal-not-found",
    });
    // Non-vacuity: that row exists and its own owner reads it.
    expect((await read(OTHER_HUMAN, [P_OTHER])).status).toBe("read");
  });
});
