/**
 * `document.freeze_charts` on PGlite — driven through the REAL builtin verb
 * handler and the REAL `entities.list` procedure (the live chart's own door),
 * over tables generated from the Drizzle definitions.
 *
 * Proves: (1) the frozen numbers equal the shared live shaper over the rows
 * the live chart's query returns, and equal the hand-counted fixture — so the
 * workspace LENS is the procedure's own (another workspace's rows and pod-wide
 * rows are not counted, a stranger's rows never); (2) a chart whose read FAILS
 * (a profile slug that names nothing → the procedure's NOT_FOUND) stays live
 * with a `freeze_failed` diagnostic; (3) a profile with zero rows freezes to
 * an explicit empty snapshot.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const pg = drizzle(client, {
    schema: {
      entities: actual.entities as never,
      entityFacets: actual.entityFacets as never,
      profiles: actual.profiles as never,
      workspaces: actual.workspaces as never,
      workspaceMembers: actual.workspaceMembers as never,
    },
  });
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { parseMarkdown, readEmbed } from "@synap-core/markdown-core";
import { shapeChartEntities } from "@synap-core/types/renderables";
import {
  BUILTIN_VERBS,
  READ_ONLY_BUILTIN_VERBS,
} from "../capabilities/builtin-verbs.js";
import { liveChartReader } from "./freeze-charts-verb.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const STRANGER = randomUUID();
const WS = randomUUID();
const WS_OTHER = randomUUID();
const NOW = new Date();

async function entity(opts: {
  user?: string;
  workspaceId: string | null;
  type: string;
  status: string;
}) {
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties, created_at, updated_at)
     values ($1, $2, $3, $4, 'x', $5::jsonb, now(), now())`,
    [
      randomUUID(),
      opts.user ?? USER,
      opts.workspaceId,
      opts.type,
      JSON.stringify({ status: opts.status }),
    ]
  );
}

const MARKDOWN = [
  "# Workspace report",
  "",
  ':::synap-cell{cellKey="chart-pie"}',
  "```json",
  '{"profileSlug":"task","groupBy":"status","label":"Tasks by status"}',
  "```",
  "",
  "Most tasks are done.",
  ":::",
  "",
  ':::synap-cell{cellKey="chart-bar"}',
  "```json",
  '{"profileSlug":"nosuchkind","groupBy":"status","label":"Ghosts"}',
  "```",
  ":::",
  "",
  ':::synap-cell{cellKey="chart-pie"}',
  "```json",
  '{"profileSlug":"note","groupBy":"status","label":"Notes by status"}',
  "```",
  ":::",
].join("\n");

function cellProps(markdown: string) {
  const out: Array<Record<string, unknown>> = [];
  const walk = (n: { type: string; name?: string; children?: unknown[] }) => {
    if (n.type === "containerDirective" && n.name === "synap-cell")
      out.push(readEmbed(n as never)!.props ?? {});
    for (const c of n.children ?? []) walk(c as typeof n);
  };
  walk(parseMarkdown(markdown) as never);
  return out;
}

beforeAll(async () => {
  const d = database as unknown as Record<string, PgTable>;
  for (const name of [
    "users",
    "workspaces",
    "workspaceMembers",
    "entities",
    "profiles",
    "entityFacets",
    "projectMembers",
    "relations",
    "podMembers",
  ]) {
    if (!d[name]) throw new Error(`no table export ${name}`);
    await h.client!.exec(ddlFor(d[name]!));
  }
  await q(`insert into users (id, email) values ($1, 'u@x'), ($2, 's@x')`, [
    USER,
    STRANGER,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'W', $3), ($2, 'Other', $3)`,
    [WS, WS_OTHER, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $4, 'owner'), ($3, $5, $4, 'owner')`,
    [randomUUID(), WS, randomUUID(), USER, WS_OTHER]
  );
  for (const slug of ["task", "note"]) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind) values ($1, $2, $2, 'kind')`,
      [randomUUID(), slug]
    );
  }
  // In the report's workspace: 2 done, 1 open.
  await entity({ workspaceId: WS, type: "task", status: "done" });
  await entity({ workspaceId: WS, type: "task", status: "done" });
  await entity({ workspaceId: WS, type: "task", status: "open" });
  // Outside the lens: another workspace, pod-wide, a stranger's private row.
  await entity({ workspaceId: WS_OTHER, type: "task", status: "open" });
  await entity({ workspaceId: null, type: "task", status: "open" });
  await entity({
    user: STRANGER,
    workspaceId: null,
    type: "task",
    status: "blocked",
  });
});

describe("document.freeze_charts through the live chart's own query", () => {
  it("is a registered, auto-running (read-only) builtin verb", () => {
    expect(BUILTIN_VERBS["document.freeze_charts"]).toBeTypeOf("function");
    expect(READ_ONLY_BUILTIN_VERBS.has("document.freeze_charts")).toBe(true);
  });

  it("freezes exactly the live chart's numbers, under the report's lens; failed → live; zero → empty snapshot", async () => {
    const live = await liveChartReader({ userId: USER, workspaceId: WS })(
      "task"
    );
    expect(live).toHaveLength(3);

    const out = (await BUILTIN_VERBS["document.freeze_charts"]!(
      { markdown: MARKDOWN },
      { userId: USER, workspaceId: WS }
    )) as {
      markdown: string;
      frozen: number;
      diagnostics: Array<{ code: string; ref: { cellKey: string } }>;
    };

    const [tasks, ghosts, notes] = cellProps(out.markdown);
    expect(tasks!.data).toEqual([
      { label: "done", value: 2 },
      { label: "open", value: 1 },
    ]);
    expect(tasks!.data).toEqual(
      shapeChartEntities("chart-pie", live, tasks!, NOW)
    );
    expect(typeof tasks!.capturedAt).toBe("string");

    expect(ghosts).not.toHaveProperty("data");
    expect(out.diagnostics).toEqual([
      expect.objectContaining({
        code: "freeze_failed",
        ref: { cellKey: "chart-bar" },
      }),
    ]);

    expect(notes!.data).toEqual([]);
    expect(typeof notes!.capturedAt).toBe("string");
    expect(out.frozen).toBe(2);
  });
});
