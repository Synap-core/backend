/**
 * `supersedes` through the MCP door (plan 8032a127 D3, review Q9): the REAL
 * `executeMCPToolViaHubProtocol` and the REAL insert door on PGlite. Only the
 * tool's own handler is a stand-in (it files the request, or applies at once),
 * and the session / caller plumbing the adapter reaches before it.
 *
 * Each case rules a wrong door rule out:
 *  - a name that is not this person's failed proposal → refused before the
 *    handler runs (rules out "file first, check later");
 *  - a tool outside SUPERSEDES_TOOLS → refused loudly (rules out "ignored");
 *  - a write that applies at once (files nothing for review) → the reply
 *    says the failed one was left failed (rules out a silent "done");
 *  - a write that files the same request for review → the failed one ends
 *    withdrawn, pointing at it, and no such note.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
    /** What the stand-in handler does: file the request, or apply it at once. */
    mode: "files" as "files" | "applies",
    handled: 0,
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});
vi.mock("../handlers/shared.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSessionHandle: async () => null,
  createHubProtocolCaller: async () => ({}),
}));
vi.mock("../../../services/proposals/proposal-updates-digest.js", () => ({
  takeProposalUpdates: async () => [],
}));
// The stand-in for the tool's own door: the request it files is the real
// insert door's row (as the entity door's `checkPermissionOrPropose` does).
vi.mock("../handlers/entity.js", async () => {
  const { insertPendingProposal } = await import("@synap/database");
  return {
    entityHandlers: {
      synap_create_entity: async (ctx: { userId: string }) => {
        h.handled += 1;
        if (h.mode === "files") {
          const { proposal } = await insertPendingProposal({
            workspaceId: null,
            targetType: "messaging",
            targetId: "ch-1",
            proposalType: "messaging.external.send",
            data: { body: `Corrected ${randomUUID()}` },
            createdBy: ctx.userId,
            agentUserId: "agent-orchestrator",
            subjectUserId: ctx.userId,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ proposalId: proposal.id }),
              },
            ],
          };
        }
        return {
          content: [
            { type: "text", text: JSON.stringify({ status: "applied" }) },
          ],
        };
      },
    },
  };
});

const AGENT = "agent-orchestrator";

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { executeMCPToolViaHubProtocol } from "../adapter.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${base === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = randomUUID();

/** A send for OWNER that failed on approval, filed by another agent. */
async function failedSend(owner = OWNER): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data,
       created_by, agent_user_id, subject_user_id)
     values ($1, 'approval_failed', 'messaging.external.send', 'messaging', 'ch-1',
       '{"body":"Hi","failure":{"errorClass":"missing_field"}}'::jsonb, 'agent-author', 'agent-author', $2)`,
    [id, owner]
  );
  return id;
}

const call = (toolName: string, args: Record<string, unknown>) =>
  executeMCPToolViaHubProtocol(
    toolName,
    args,
    OWNER,
    ["mcp.read", "mcp.write"],
    undefined,
    AGENT
  );

const textOf = (r: { content?: unknown[] }) =>
  (r.content ?? []).map((b) => (b as { text?: string }).text ?? "").join("\n");

const statusOf = async (id: string) =>
  (
    await q<{ status: string; data: Record<string, unknown> }>(
      `select status, data from proposals where id = $1`,
      [id]
    )
  ).rows[0]!;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from proposals; delete from notifications;`);
  h.mode = "files";
  h.handled = 0;
});

describe("supersedes at the MCP door", () => {
  it("a name that is not this person's failed proposal is refused before the tool runs", async () => {
    const theirs = await failedSend(randomUUID());
    const out = await call("synap_create_entity", { supersedes: theirs });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/not a proposal filed for the same person/);
    expect(h.handled).toBe(0);
    expect((await statusOf(theirs)).status).toBe("approval_failed");
  });

  it("a tool that does not take it refuses it loudly", async () => {
    const failed = await failedSend();
    const out = await call("synap_post_message", {
      supersedes: failed,
      content: "x",
    });
    expect(out.isError).toBe(true);
    expect(textOf(out)).toMatch(/does not take `supersedes`/);
    expect((await statusOf(failed)).status).toBe("approval_failed");
  });

  it("a write that applies at once says the failed one was left failed", async () => {
    const failed = await failedSend();
    h.mode = "applies";
    const out = await call("synap_create_entity", { supersedes: failed });
    expect(out.isError).not.toBe(true);
    expect(textOf(out)).toMatch(/left as it is \(still failed\)/);
    expect((await statusOf(failed)).status).toBe("approval_failed");
  });

  it("a write that files the same request ends the failed one, pointing at it", async () => {
    const failed = await failedSend();
    const out = await call("synap_create_entity", { supersedes: failed });
    const filed = JSON.parse((out.content[0] as { text: string }).text) as {
      proposalId: string;
    };
    expect(textOf(out)).not.toMatch(/still failed/);
    const old = await statusOf(failed);
    expect(old.status).toBe("withdrawn");
    expect(old.data.supersededBy).toBe(filed.proposalId);
  });
});
