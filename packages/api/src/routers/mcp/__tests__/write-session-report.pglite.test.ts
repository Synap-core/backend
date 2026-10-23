/**
 * The MCP write reply names WHERE the writes landed (B4 e, 2026-10-21), and
 * hints when a write's project is not the project of the session the client
 * STARTED (B4 c: a started session never splits).
 *
 * Real: `describeWriteSessions` over PGlite (focus_sessions, projects, users),
 * fed the ledger shape the gate records (`recordWriteSessionFiling`, whose
 * recording is pinned in `permission-check.receipt-by-project.test.ts`).
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
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});
const { focus } = vi.hoisted(() => ({
  focus: { projectId: null as string | null },
}));
vi.mock(
  "../../../services/agent-identity-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAgentFocusProjectId: async () => focus.projectId,
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, projects } from "@synap/database/schema";
import {
  describeWriteSessions,
  topicHintNote,
} from "../write-session-report.js";

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
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "user-1";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

async function sessionRow(opts: {
  title: string;
  projectId?: string | null;
  receipt?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, title, goal, status, project_id, metadata)
     values ($1, $2, $3, 'goal', 'active', $4, $5::jsonb)`,
    [
      id,
      USER,
      opts.title,
      opts.projectId ?? null,
      JSON.stringify(
        opts.receipt ? { autoOpened: true, kind: "agent-proposal-package" } : {}
      ),
    ]
  );
  return id;
}

beforeAll(async () => {
  await import("@synap/database");
  await h.client!.exec(
    [focusSessions, projects].map((t) => ddlFor(t as PgTable)).join("\n")
  );
  await q(
    `insert into projects (id, name) values ($1, 'Launch'), ($2, 'Radar')`,
    [P1, P2]
  );
}, 120_000);
beforeEach(async () => {
  focus.projectId = null;
  await q(`delete from focus_sessions`);
});

describe("the write reply names where the writes landed", () => {
  it("nothing filed → no block (a read, or a call that wrote nothing)", async () => {
    expect(await describeWriteSessions([], { userId: USER })).toBeUndefined();
  });

  it("names each session by id and title, receipt or started", async () => {
    const r = await sessionRow({
      title: "Changes in Launch",
      projectId: P1,
      receipt: true,
    });
    const s = await sessionRow({ title: "Ship the CRM spec", projectId: P1 });
    const out = await describeWriteSessions(
      [
        { sessionId: r, projectId: P1 },
        { sessionId: s, projectId: P1 },
      ],
      { userId: USER }
    );
    expect(out).toEqual({
      status: "ok",
      filedIn: [
        { sessionId: r, title: "Changes in Launch", kind: "receipt" },
        { sessionId: s, title: "Ship the CRM spec", kind: "session" },
      ],
    });
  });

  it("a STARTED session written about another project → a topic hint, named", async () => {
    const s = await sessionRow({ title: "Ship the CRM spec", projectId: P1 });
    const out = await describeWriteSessions([{ sessionId: s, projectId: P2 }], {
      userId: USER,
    });
    expect(out).toMatchObject({
      status: "ok",
      topicHint: {
        sessionId: s,
        sessionProject: { id: P1, name: "Launch" },
        writeProject: { id: P2, name: "Radar" },
        suggest: "synap_start_session",
      },
    });
    if (out?.status !== "ok" || !out.topicHint) throw new Error("no hint");
    expect(topicHintNote(out.topicHint)).toContain('"Radar"');
  });

  it("the write's project falls back to the conversation's focus", async () => {
    focus.projectId = P2;
    const s = await sessionRow({ title: "Ship the CRM spec", projectId: P1 });
    const out = await describeWriteSessions(
      [{ sessionId: s, projectId: null }],
      {
        userId: USER,
        agentUserId: "agent-1",
      }
    );
    expect(out).toMatchObject({ topicHint: { writeProject: { id: P2 } } });
  });

  it("CONTROL — no hint for a receipt, the same project, or a session with no project", async () => {
    const receipt = await sessionRow({
      title: "R",
      projectId: P1,
      receipt: true,
    });
    const same = await sessionRow({ title: "S", projectId: P2 });
    const general = await sessionRow({ title: "G", projectId: null });
    const out = await describeWriteSessions(
      [
        { sessionId: receipt, projectId: P2 },
        { sessionId: same, projectId: P2 },
        { sessionId: general, projectId: P2 },
      ],
      { userId: USER }
    );
    expect(out?.status).toBe("ok");
    expect(out).not.toHaveProperty("topicHint");
  });

  it("another person's session is never named", async () => {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, title, goal, status) values ($1, 'user-2', 'Theirs', 'g', 'active')`,
      [id]
    );
    const out = await describeWriteSessions(
      [{ sessionId: id, projectId: null }],
      {
        userId: USER,
      }
    );
    expect(out).toEqual({ status: "ok", filedIn: [] });
  });
});
