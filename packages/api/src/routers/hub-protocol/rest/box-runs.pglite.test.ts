/**
 * The box-runs Hub routes refuse every caller that is not a COMPUTER holding
 * `box.runner`, before any run is read — and a computer with the scope leases,
 * heartbeats and finishes through them.
 *
 * Driven on PGlite through the real routes and the real service; the auth
 * middleware is replaced by one that sets what `hubAuthMiddleware` sets for a
 * key (scopes, the linked person as `userId`, the key's agent as
 * `agentUserId`), so each row below is one kind of key:
 *   - a computer key WITHOUT `box.runner` → 403 SCOPE_REQUIRED;
 *   - an AGENT key (not a machine) WITH the scope → 403 NOT_A_COMPUTER;
 *   - a computer key whose person is not the computer's own → 403;
 *   - the computer's own key with the scope → the run.
 *
 * And the body door: a body that is not JSON is a 400 (never read as `{}`),
 * an absent one is `{}`, a log end past its bound is a 400, and a body past
 * the route ceiling is a 413 before any handler parses it.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
vi.mock("../../../services/capabilities/execute-capability.js", () => ({
  markSkillProven: async () => {},
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerBoxRunsRoutes } from "./box-runs.js";
import { enqueueBoxRun } from "../../../services/box-runs/box-runs.js";
import type { HubHono, HubVariables } from "./_shared.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0356 = readFileSync(
  resolve(HERE, "../../../../../database/migrations/0356_box_runs.sql"),
  "utf8"
);
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = "person-a";
const MACHINE = "machine-1";
const AGENT = "agent-1";
const SKILL = randomUUID();

function appAs(vars: {
  scopes: string[];
  userId: string;
  agentUserId?: string;
}): HubHono {
  const app = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", vars.scopes);
    c.set("userId", vars.userId);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    await next();
  });
  registerBoxRunsRoutes(app);
  return app;
}

const post = (app: HubHono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const BASE = [
  "hub-protocol.read",
  "hub-protocol.write",
  "mcp.read",
  "mcp.write",
];

beforeAll(async () => {
  await h.client!.exec(`
    CREATE TABLE users (id text PRIMARY KEY, name text, agent_type text,
      created_by_user_id text);
    CREATE TABLE skills (id uuid PRIMARY KEY, name text NOT NULL, code text,
      metadata jsonb DEFAULT '{}'::jsonb, proven_at timestamptz,
      status text NOT NULL DEFAULT 'active', approved boolean NOT NULL DEFAULT true);
    CREATE TABLE api_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL, scope text[], is_active boolean NOT NULL DEFAULT true,
      expires_at timestamptz, revoked_at timestamptz);
  `);
  await h.client!.exec(M0356);
  await q(
    `INSERT INTO users VALUES ($1, 'person', NULL, NULL), ($2, 'devbox', 'machine', $1), ($3, 'Claude Code', 'claude-code', $1)`,
    [PERSON, MACHINE, AGENT]
  );
  await q(`INSERT INTO api_keys (user_id, scope) VALUES ($1, $2)`, [
    MACHINE,
    [...BASE, "box.runner"],
  ]);
  await q(
    `INSERT INTO skills (id, name, code, metadata) VALUES ($1, 'chart', 'print(1)', $2)`,
    [SKILL, JSON.stringify({ box: { language: "python" } })]
  );
  const queued = await enqueueBoxRun({
    skillId: SKILL,
    parameters: {},
    userId: PERSON,
  });
  if (!queued.ok) throw new Error(queued.error);
}, 60_000);

describe("box-runs routes — who may call", () => {
  it("a computer key without box.runner is refused", async () => {
    const res = await post(
      appAs({ scopes: BASE, userId: PERSON, agentUserId: MACHINE }),
      "/box-runs/lease",
      {}
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "SCOPE_REQUIRED" });
  });

  it("an agent key holding the scope is not a computer", async () => {
    const res = await post(
      appAs({
        scopes: [...BASE, "box.runner"],
        userId: PERSON,
        agentUserId: AGENT,
      }),
      "/box-runs/lease",
      {}
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "NOT_A_COMPUTER" });
  });

  it("a person's own key (no agent) holding the scope is not a computer", async () => {
    const res = await post(
      appAs({ scopes: [...BASE, "box.runner"], userId: PERSON }),
      "/box-runs/lease",
      {}
    );
    expect(res.status).toBe(403);
  });

  it("a computer acting for another person is refused", async () => {
    const res = await post(
      appAs({
        scopes: [...BASE, "box.runner"],
        userId: "person-b",
        agentUserId: MACHINE,
      }),
      "/box-runs/lease",
      {}
    );
    expect(res.status).toBe(403);
  });

  it("the computer's own key with the scope leases, heartbeats and finishes", async () => {
    const app = appAs({
      scopes: [...BASE, "box.runner"],
      userId: PERSON,
      agentUserId: MACHINE,
    });
    const leased = await post(app, "/box-runs/lease", {
      capacity: { memoryMb: 4096 },
    });
    expect(leased.status).toBe(200);
    const { run } = (await leased.json()) as {
      run: {
        id: string;
        leaseId: string;
        script: { language: string; entrypoint: string };
      };
    };
    expect(run.script).toMatchObject({
      language: "python",
      entrypoint: "main.py",
    });

    const hb = await post(app, `/box-runs/${run.id}/heartbeat`, {
      leaseId: run.leaseId,
      phase: "running",
    });
    expect(hb.status).toBe(200);
    expect(await hb.json()).toMatchObject({ stopRequested: false });

    const stale = await post(app, `/box-runs/${run.id}/heartbeat`, {
      leaseId: randomUUID(),
      phase: "running",
    });
    expect(stale.status).toBe(409);

    const infraNoReason = await post(app, `/box-runs/${run.id}/finish`, {
      leaseId: run.leaseId,
      status: "infra",
    });
    expect(infraNoReason.status).toBe(400);

    const fin = await post(app, `/box-runs/${run.id}/finish`, {
      leaseId: run.leaseId,
      status: "timeout",
      exitCode: null,
      durationMs: 900_000,
      log: { head: "working…", tail: "", totalBytes: 9, truncated: false },
      files: [{ path: "partial.csv", size: 10 }],
    });
    expect(fin.status).toBe(200);
    expect(await fin.json()).toMatchObject({
      id: run.id,
      status: "failed",
      files: [{ path: "partial.csv", status: "not_stored" }],
    });
    const again = await post(app, `/box-runs/${run.id}/finish`, {
      leaseId: run.leaseId,
      status: "done",
    });
    expect(again.status).toBe(409);
    expect(await (await post(app, "/box-runs/lease", {})).json()).toEqual({
      run: null,
    });
  });

  it("a malformed run id is a 400, not a 500", async () => {
    const res = await post(
      appAs({
        scopes: [...BASE, "box.runner"],
        userId: PERSON,
        agentUserId: MACHINE,
      }),
      "/box-runs/not-a-uuid/heartbeat",
      { leaseId: randomUUID(), phase: "setup" }
    );
    expect(res.status).toBe(400);
  });

  it("a body that is not JSON is a 400, an absent body is {}", async () => {
    const app = appAs({
      scopes: [...BASE, "box.runner"],
      userId: PERSON,
      agentUserId: MACHINE,
    });
    const garbage = await app.request("/box-runs/lease", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({
      code: "BAD_REQUEST",
      error: "body is not valid JSON",
    });
    const absent = await app.request("/box-runs/lease", { method: "POST" });
    expect(absent.status).toBe(200);
  });

  it("a log end past its bound is a 400; a body past the ceiling is a 413", async () => {
    const app = appAs({
      scopes: [...BASE, "box.runner"],
      userId: PERSON,
      agentUserId: MACHINE,
    });
    const id = randomUUID();
    const leaseId = randomUUID();
    const longLog = await post(app, `/box-runs/${id}/finish`, {
      leaseId,
      status: "done",
      log: { head: "x".repeat(4 * 64 * 1024 + 1) },
    });
    expect(longLog.status).toBe(400);
    expect((await longLog.json()).error).toMatch(/^log\.head/);
    // Valid as a finish (unknown keys are stripped): without the ceiling it
    // would be parsed whole and answered 404 for the unknown run.
    const huge = await post(app, `/box-runs/${id}/finish`, {
      leaseId,
      status: "done",
      padding: "z".repeat(3 * 1024 * 1024),
    });
    expect(huge.status).toBe(413);
  });
});
