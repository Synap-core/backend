/**
 * THE ONE TOOLS FIELD through the REAL `playbooks.create` / `playbooks.update`
 * procedures on PGlite (every table from the Drizzle schema), then the REAL
 * run tool resolver reading the stored row (plan 08e4fba7, decisions 3 and 4).
 * Only governance, audit, side effects and the capability registry are
 * stubbed.
 *
 * Pinned:
 *  - a declared `tools` list is stored, and a run of the playbook gets its
 *    class floor plus that list and nothing else;
 *  - a stage list outside the playbook's is REFUSED at the door (create and
 *    update), and nothing is saved;
 *  - the deprecated `requiredIntents` and stage `grants` are folded into
 *    `tools` at the door, never stored apart;
 *  - a one-shot (`generate`) playbook's run gets no tools.
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
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { LONG_RUN_FLOOR, SHORT_RUN_FLOOR } from "@synap/playbooks";
import { playbooksRouter } from "./playbooks.js";
import {
  defaultDeps,
  resolveRunToolProfile,
} from "../services/playbooks/run-tool-profile.js";

const OWNER = randomUUID();
const WS = randomUUID();

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
        : c.name === "version"
          ? " default 1"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const caller = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: OWNER,
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

const stage = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: key,
  category: "started" as const,
  ...extra,
});

/** The registry, stubbed: one capability whose two verbs a list may name. */
const deps = {
  ...defaultDeps,
  readRegistry: async () => ({
    index: new Map(),
    capabilities: [
      {
        kind: "tool",
        id: "tool-fireflies",
        name: "fireflies",
        verbs: [{ id: "fireflies_search", kind: "read" }],
      },
    ],
  }),
};

async function row(id: string) {
  const { rows } = await q(
    `select tools, stages from playbooks where id = $1`,
    [id]
  );
  return rows[0] as {
    tools: string[];
    stages: Array<Record<string, unknown>>;
  };
}

async function count(name: string): Promise<number> {
  const { rows } = await q(
    `select count(*)::int as n from playbooks where name = $1`,
    [name]
  );
  return (rows[0] as { n: number }).n;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Studio',$2,'{"taskIntents":["send_message"]}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
}, 120_000);

async function create(input: Record<string, unknown>): Promise<string> {
  const out = (await caller().create({
    goalTemplate: `Do ${String(input.name)}`,
    status: "active",
    ...input,
  } as never)) as { playbook?: { id: string } };
  expect(out.playbook?.id, `create ${String(input.name)}`).toBeDefined();
  return out.playbook!.id;
}

const run = (playbookId: string) =>
  resolveRunToolProfile({ playbookId, workspaceId: WS, userId: OWNER }, deps);

describe("one tools field — the door stores it, the run gets floor plus only these", () => {
  it("a short playbook's run gets the 6 reads plus its declared tools, and nothing else", async () => {
    const id = await create({
      name: "Write the caption",
      tools: ["update_document", "fireflies"],
    });
    expect((await row(id)).tools).toEqual(["update_document", "fireflies"]);
    const p = await run(id);
    expect(p.capabilitiesRead).toBe("ok");
    expect(p.tools).toEqual([...SHORT_RUN_FLOOR, "update_document"]);
    expect(p.verbs).toEqual(["fireflies_search"]);
    // The space's taskIntents are no longer a run declaration.
    expect(p.intents).toEqual([]);
  });

  it("a long playbook's run gets its floor (the core, the relation read, its own session tools) plus its declared ones", async () => {
    const id = await create({
      name: "Ship a change",
      tools: ["web_fetch"],
      stages: [stage("a"), stage("b"), stage("c")],
    });
    const p = await run(id);
    expect(p.tools).toEqual([...LONG_RUN_FLOOR, "web_fetch"]);
  });

  it("a one-shot (generate) playbook's run gets no tools", async () => {
    const id = await create({
      name: "Caption now",
      tools: ["update_document"],
    });
    // The generate executor lands with its own PR; the row is written the way
    // that door writes it.
    await q(`update playbooks set executor = 'generate' where id = $1`, [id]);
    const p = await run(id);
    expect(p.runClass).toBe("one-shot");
    expect(p.tools).toEqual([]);
    expect(p.verbs).toEqual([]);
  });

  it("refuses at create a stage list outside the playbook's, and saves nothing", async () => {
    await expect(
      caller().create({
        name: "Wider stage",
        goalTemplate: "Do it",
        tools: ["update_document"],
        stages: [stage("draft", { tools: ["update_document", "web_search"] })],
      } as never)
    ).rejects.toThrow(/Stage "draft" lists "web_search"/);
    expect(await count("Wider stage")).toBe(0);
  });

  it("refuses at update a narrowed playbook list a stored stage still uses, and changes nothing", async () => {
    const id = await create({
      name: "Narrow me",
      tools: ["update_document", "web_search"],
      stages: [stage("draft", { tools: ["web_search"] })],
    });
    await expect(
      caller().update({ id, tools: ["update_document"] } as never)
    ).rejects.toThrow(/Stage "draft" lists "web_search"/);
    expect((await row(id)).tools).toEqual(["update_document", "web_search"]);
  });

  it("folds the deprecated requiredIntents and stage grants into tools, never stored apart", async () => {
    const id = await create({
      name: "Old shape",
      requiredIntents: ["send_message"],
      stages: [
        stage("research", {
          grants: [{ kind: "skill", id: "source-triage" }],
        }),
      ],
    });
    const r = await row(id);
    expect(r.tools).toEqual(["send_message", "source-triage"]);
    expect(r.stages[0]).not.toHaveProperty("grants");
    expect(r.stages[0]!.tools).toEqual(["source-triage"]);
  });
});
