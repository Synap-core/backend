/**
 * A GOAL id resolves, on a REAL Postgres (PGlite): `resolveObjectKind`'s
 * `track` probe, the `/open` target it projects to, and diagnose's explainer.
 *
 * Every `/open/<id>` link an agent hands out for a goal resolved to
 * `unknown` — pod-admin said "Nothing here" for a live goal. The probe is
 * floored like `tracks.get`: a goal is exactly as visible as its project
 * (the `project_tracks` VisibilityRule is `projectVisibleWhere`), so a goal of
 * a project the reader cannot see stays `null`, never a named hit.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
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
  const d = await h.init();
  return { ...actual, db: d, getDb: async () => d };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { resolveObjectKind } from "../resolve-object-kind.js";
import { diagnoseRouter } from "../index.js";
import { resolveOpenTarget } from "../../../routers/hub-protocol/rest/resolve-open-target.js";

const OWNER = randomUUID();
const STRANGER = randomUUID();
const WS = randomUUID();
const PROJECT = randomUUID();
const STRANGERS_PROJECT = randomUUID();
const GOAL = randomUUID();
const STRANGERS_GOAL = randomUUID();

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
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.hasDefault && type === "jsonb"
          ? ` default '{}'::jsonb`
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  for (const table of Object.values(schema)) {
    try {
      getTableConfig(table as PgTable);
    } catch {
      continue;
    }
    await h.client!.exec(ddlFor(table as PgTable)).catch(() => undefined);
  }
  for (const [id, name] of [
    [OWNER, "Owner"],
    [STRANGER, "Stranger"],
  ] as const) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'human')`,
      [id, `${name.toLowerCase()}@x.test`, name]
    );
  }
  await q(`insert into workspaces (id, name, owner_id) values ($1, 'W', $2)`, [
    WS,
    OWNER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );
  // OWNER's project lives in a space; STRANGER's is pod-personal (owner floor).
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values
      ($1, $2, $3, 'Synap', 'active'),
      ($4, $5, null, 'Theirs', 'active')`,
    [PROJECT, OWNER, WS, STRANGERS_PROJECT, STRANGER]
  );
  await q(
    `insert into project_tracks (id, project_id, user_id, name, status, verdict) values
      ($1, $2, $3, 'Intent-first work model', 'active', null),
      ($4, $5, $6, 'Their goal', 'completed', 'met')`,
    [GOAL, PROJECT, OWNER, STRANGERS_GOAL, STRANGERS_PROJECT, STRANGER]
  );
});

describe("a goal id resolves to a goal, floored on its project", () => {
  it("resolves a goal of a visible project, named, with its project's space", async () => {
    expect(await resolveObjectKind(GOAL, OWNER)).toMatchObject({
      kind: "track",
      id: GOAL,
      displayName: "Intent-first work model",
      workspaceId: WS,
    });
  });

  it("a goal of a pod-personal project resolves for its project's owner", async () => {
    expect((await resolveObjectKind(STRANGERS_GOAL, STRANGER))?.kind).toBe(
      "track"
    );
  });

  it("a goal of a project the reader cannot see resolves to nothing", async () => {
    expect(await resolveObjectKind(STRANGERS_GOAL, OWNER)).toBeNull();
  });

  it("projects onto an openable `track` link (the /open dispatch and the apps)", async () => {
    expect(await resolveOpenTarget(GOAL, OWNER)).toMatchObject({
      type: "track",
      id: GOAL,
      displayName: "Intent-first work model",
      openable: true,
    });
    expect(await resolveOpenTarget(STRANGERS_GOAL, OWNER)).toMatchObject({
      type: "unknown",
      openable: false,
    });
  });

  it("diagnose explains a goal (its status and verdict)", async () => {
    expect(
      await diagnoseRouter({ userId: STRANGER, id: STRANGERS_GOAL })
    ).toMatchObject({
      mode: "object",
      kind: "track",
      summary: 'Goal "Their goal" is completed (met)',
    });
  });
});
