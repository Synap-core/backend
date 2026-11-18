/**
 * `supersedes` through the Hub REST door (plan 8032a127 D3): the REAL
 * wrapper (`supersedesMiddleware`), the REAL shared door (`fileSuperseding`)
 * and the REAL insert door on PGlite. Only the route behind the wrapper is a
 * stand-in (it files the request, or applies at once), as in the MCP door's
 * test (`routers/mcp/__tests__/supersedes-adapter.pglite.test.ts`): the two
 * doors must answer the same cases the same way.
 *
 * Each case rules a wrong door rule out:
 *  - a name that is not this person's failed proposal → 409 before the route
 *    runs (rules out "file first, check later");
 *  - a route that applies at once (files nothing for review) → the answer
 *    says the failed one was left failed (rules out a silent "done");
 *  - a route that files the same request for review → the failed one ends
 *    withdrawn, pointing at it, and the answer names the replacement;
 *  - a route that files ANOTHER request (wave-2 code review 1 and 2) → 409
 *    SUPERSEDES_REFUSED, nothing filed, the failed one stays failed, whether
 *    the route lets the insert door's throw out (an app with `onError`, as the
 *    pod's, or none) or answers it as its own 500 (rules out "a 500", and
 *    "filed beside a failure that never ends").
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

import { Hono } from "hono";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { insertPendingProposal } from "@synap/database";
import { supersedesMiddleware, SUPERSEDES_REFUSED } from "./supersedes.js";

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

/**
 * What the stand-in route does: file the request, apply it at once, or file
 * ANOTHER request (an entity update) and let the insert door's refusal out
 * (`other`) or answer it as its own 500 (`other-caught`).
 */
let mode: "files" | "applies" | "other" | "other-caught" = "files";
let handled = 0;

/** The pod's app has an `onError`; one without is covered by `bare`. */
function build(withOnError: boolean): Hono {
  const app = new Hono();
  if (withOnError) {
    app.onError((err, c) => c.json({ error: String(err) }, 500));
  }
  app.use("/*", async (c, next) => {
    c.set("userId" as never, OWNER as never);
    await next();
  });
  app.use("/file", supersedesMiddleware("POST"));
  app.post("/file", async (c) => {
    handled += 1;
    // The route reads the body the wrapper already read (Hono caches it).
    const body = (await c.req.json()) as { text: string };
    if (mode === "applies") return c.json({ status: "applied" });
    const other = mode === "other" || mode === "other-caught";
    const filing = () =>
      insertPendingProposal({
        workspaceId: null,
        targetType: other ? "entity" : "messaging",
        targetId: other ? "e-1" : "ch-1",
        proposalType: other ? "update" : "messaging.external.send",
        data: { body: body.text },
        createdBy: OWNER,
        agentUserId: "agent-orchestrator",
        subjectUserId: OWNER,
      });
    let proposal: { id: string };
    try {
      ({ proposal } = await filing());
    } catch (err) {
      if (mode === "other-caught") {
        return c.json({ error: "Internal error" }, 500);
      }
      throw err;
    }
    return c.json({ status: "proposed", proposalId: proposal.id }, 202);
  });
  return app;
}
const app = build(true);
const bare = build(false);

const file = (body: Record<string, unknown>, on: Hono = app) =>
  on.request("/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `Corrected ${randomUUID()}`, ...body }),
  });

/** A send for `owner` that failed on approval, filed by another agent. */
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
  mode = "files";
  handled = 0;
});

describe("supersedes at the Hub REST door", () => {
  it("a name that is not this person's failed proposal is refused before the route runs", async () => {
    const theirs = await failedSend(randomUUID());
    const res = await file({ supersedes: theirs });
    const body = (await res.json()) as { error: string; code: string };
    expect(res.status).toBe(409);
    expect(body.code).toBe(SUPERSEDES_REFUSED);
    expect(body.error).toMatch(/not a proposal filed for the same person/);
    expect(handled).toBe(0);
    expect((await statusOf(theirs)).status).toBe("approval_failed");
  });

  it("a route that applies at once says the failed one was left failed", async () => {
    const failed = await failedSend();
    mode = "applies";
    const res = await file({ supersedes: failed });
    const body = (await res.json()) as {
      status: string;
      supersedes: { proposalId: string; replacedBy: null; note: string };
    };
    expect(res.status).toBe(200);
    expect(body.status).toBe("applied");
    expect(body.supersedes.proposalId).toBe(failed);
    expect(body.supersedes.replacedBy).toBeNull();
    expect(body.supersedes.note).toMatch(/left as it is \(still failed\)/);
    expect((await statusOf(failed)).status).toBe("approval_failed");
  });

  it("a route that files the same request ends the failed one, pointing at it", async () => {
    const failed = await failedSend();
    const res = await file({ supersedes: failed });
    const body = (await res.json()) as {
      proposalId: string;
      supersedes: { proposalId: string; replacedBy: string; note?: string };
    };
    expect(res.status).toBe(202);
    expect(handled).toBe(1);
    expect(body.supersedes).toEqual({
      proposalId: failed,
      replacedBy: body.proposalId,
    });
    const old = await statusOf(failed);
    expect(old.status).toBe("withdrawn");
    expect(old.data.supersededBy).toBe(body.proposalId);
  });

  for (const [label, run] of [
    ["lets the refusal out to the app's onError", () => (mode = "other")],
    ["answers the refusal as its own 500", () => (mode = "other-caught")],
  ] as const) {
    it(`a route that files another request and ${label} answers 409, nothing filed`, async () => {
      const failed = await failedSend();
      run();
      const res = await file({ supersedes: failed });
      const body = (await res.json()) as { error: string; code: string };
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(body.code).toBe(SUPERSEDES_REFUSED);
      expect(body.error).toMatch(
        /another kind of request \(messaging\.external\.send on messaging\).*Nothing was filed\./
      );
      expect(handled).toBe(1);
      expect((await statusOf(failed)).status).toBe("approval_failed");
      const { rows } = await q<{ n: number }>(
        `select count(*)::int as n from proposals`
      );
      expect(rows[0]!.n).toBe(1);
    });
  }

  it("an app with no onError: the refusal the route lets out is a 409 too", async () => {
    const failed = await failedSend();
    mode = "other";
    const res = await file({ supersedes: failed }, bare);
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(409);
    expect(body.code).toBe(SUPERSEDES_REFUSED);
    expect((await statusOf(failed)).status).toBe("approval_failed");
  });

  it("without `supersedes` the route runs untouched", async () => {
    const res = await file({});
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(202);
    expect(body).not.toHaveProperty("supersedes");
  });
});
