/**
 * NAME FLOOR — `enrichProposalsForDisplay` must resolve a referenced object's
 * NAME only when the viewer could read that object. Driven through the REAL
 * function on PGlite, with the real visibility predicates (`scopedDb(access)
 * .predicate(table)`, `userVisibleWhere`, `visibleSkillsWhere`) compiled and
 * executed as SQL — nothing between the stored row and the enriched field is
 * hand-built.
 *
 * The defect this pins: every name batch read `inArray(id)` with no access
 * predicate. `POST /links` accepts endpoint ids it never visibility-checks for
 * several types, so an agent could file a link to a channel / playbook it
 * cannot see, list its own proposals, and read the name back — a name oracle.
 *
 * What this CANNOT see: the production Postgres (PGlite tables are generated
 * from the Drizzle definitions without FKs, NOT NULL or enums), the lens-scoped
 * callers above this function (list/get access-checks on the proposal itself),
 * and the entity / session / document batches, which have their own floors and
 * their own suites.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { enrichProposalsForDisplay } from "./display.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS_SEEN = randomUUID(); // viewer is a member
const WS_HIDDEN = randomUUID(); // owned by OTHER, viewer not a member

const id = () => randomUUID();
const PLAYBOOK_SEEN = id();
const PLAYBOOK_HIDDEN = id();
const PROJECT_SEEN = id();
const PROJECT_HIDDEN = id();
const AUTOMATION_SEEN = id();
const AUTOMATION_HIDDEN = id();
const CHANNEL_SEEN = id();
const CHANNEL_HIDDEN = id();
const SKILL_SEEN = id();
const SKILL_HIDDEN = id();
const TOOL_SEEN = id();
const TOOL_HIDDEN = id();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

/** Columns + types only (no constraints) — the queries under test read, never write. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

function proposalRow(over: Record<string, unknown>) {
  const now = new Date();
  return {
    id: id(),
    status: "pending",
    proposalType: "create",
    targetType: "entity",
    targetId: id(),
    data: {},
    workspaceId: WS_SEEN,
    projectId: null,
    threadId: null,
    sessionId: null,
    correlationId: null,
    agentUserId: null,
    subjectUserId: null,
    createdBy: VIEWER,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as never;
}

async function enrichOne(over: Record<string, unknown>) {
  const [row] = await enrichProposalsForDisplay([proposalRow(over)], VIEWER);
  return row as unknown as Record<string, unknown> & {
    request: { data: Record<string, unknown> };
  };
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  // Aliased exports name the same table twice — create each once.
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Seen WS',$3),($2,'Hidden WS',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [id(), WS_SEEN, VIEWER, id(), WS_HIDDEN, OTHER]
  );
  await q(
    `insert into playbooks (id, name, goal_template, workspace_id) values ($1,'Seen playbook','g',$2),($3,'Hidden playbook','g',$4)`,
    [PLAYBOOK_SEEN, WS_SEEN, PLAYBOOK_HIDDEN, WS_HIDDEN]
  );
  // A NULL-workspace project is owner-private (registry rule), so OTHER's is hidden.
  await q(
    `insert into projects (id, name, user_id, workspace_id) values ($1,'Seen project',$2,$3),($4,'Hidden project',$5,null)`,
    [PROJECT_SEEN, VIEWER, WS_SEEN, PROJECT_HIDDEN, OTHER]
  );
  await q(
    `insert into automations (id, name, workspace_id) values ($1,'Seen automation',$2),($3,'Hidden automation',$4)`,
    [AUTOMATION_SEEN, WS_SEEN, AUTOMATION_HIDDEN, WS_HIDDEN]
  );
  // Personal channels: owner-only.
  await q(
    `insert into channels (id, title, user_id, workspace_id, channel_type) values ($1,'Seen channel',$2,null,'personal'),($3,'Hidden channel',$4,null,'personal')`,
    [CHANNEL_SEEN, VIEWER, CHANNEL_HIDDEN, OTHER]
  );
  // A `user`-scope skill is its owner's alone.
  await q(
    `insert into skills (id, name, slug, user_id, scope) values ($1,'Seen skill','seen',$2,'user'),($3,'Hidden skill','hidden',$4,'user')`,
    [SKILL_SEEN, VIEWER, SKILL_HIDDEN, OTHER]
  );
  await q(
    `insert into tools (id, name, workspace_id) values ($1,'Seen tool',$2),($3,'Hidden tool',$4)`,
    [TOOL_SEEN, WS_SEEN, TOOL_HIDDEN, WS_HIDDEN]
  );
});

describe("enrichProposalsForDisplay — names are floored to what the viewer may read", () => {
  it("/links endpoints: a hidden channel / playbook resolve to NO label", async () => {
    const out = await enrichOne({
      targetType: "link",
      data: {
        fromType: "channel",
        fromId: CHANNEL_HIDDEN,
        toType: "playbook",
        toId: PLAYBOOK_HIDDEN,
        linkType: "uses",
      },
    });
    expect(out.request.data.sourceLabel).toBeUndefined();
    expect(out.request.data.targetLabel).toBeUndefined();
  });

  it("/links endpoints: a visible channel / playbook resolve to their names", async () => {
    const out = await enrichOne({
      targetType: "link",
      data: {
        fromType: "channel",
        fromId: CHANNEL_SEEN,
        toType: "playbook",
        toId: PLAYBOOK_SEEN,
        linkType: "uses",
      },
    });
    expect(out.request.data.sourceLabel).toBe("Seen channel");
    expect(out.request.data.targetLabel).toBe("Seen playbook");
  });

  it("/links endpoints: project / automation / workspace / tool / skill are floored too", async () => {
    const pairs: Array<[string, string, string, string]> = [
      ["project", PROJECT_SEEN, PROJECT_HIDDEN, "Seen project"],
      ["automation", AUTOMATION_SEEN, AUTOMATION_HIDDEN, "Seen automation"],
      ["workspace", WS_SEEN, WS_HIDDEN, "Seen WS"],
      ["tool", TOOL_SEEN, TOOL_HIDDEN, "Seen tool"],
      ["skill", SKILL_SEEN, SKILL_HIDDEN, "Seen skill"],
    ];
    for (const [type, seen, hidden, name] of pairs) {
      const out = await enrichOne({
        targetType: "link",
        data: { fromType: type, fromId: seen, toType: type, toId: hidden },
      });
      expect([type, out.request.data.sourceLabel]).toEqual([type, name]);
      expect([type, out.request.data.targetLabel]).toEqual([type, undefined]);
    }
  });

  it("plain name fields: visible ids resolve, hidden ids do not", async () => {
    const cases: Array<{
      over: Record<string, unknown>;
      field: string;
      seen: string;
    }> = [
      {
        over: {
          targetType: "focus_session",
          data: { playbookId: PLAYBOOK_SEEN },
        },
        field: "playbookName",
        seen: "Seen playbook",
      },
      {
        over: { projectId: PROJECT_SEEN },
        field: "projectName",
        seen: "Seen project",
      },
      {
        over: {
          targetType: "automation",
          data: { automationId: AUTOMATION_SEEN },
        },
        field: "automationName",
        seen: "Seen automation",
      },
      {
        over: { targetType: "workspace", data: { workspaceId: WS_SEEN } },
        field: "workspaceName",
        seen: "Seen WS",
      },
      {
        over: {
          proposalType: "governance.tighten_posture",
          data: { channelId: CHANNEL_SEEN },
        },
        field: "channelName",
        seen: "Seen channel",
      },
      {
        over: { threadId: CHANNEL_SEEN },
        field: "originChannelName",
        seen: "Seen channel",
      },
      {
        over: {
          proposalType: "capability.run",
          data: { capabilityId: SKILL_SEEN },
        },
        field: "capabilityCallLabel",
        seen: "Seen skill",
      },
    ];
    const hide: Record<string, string> = {
      [PLAYBOOK_SEEN]: PLAYBOOK_HIDDEN,
      [PROJECT_SEEN]: PROJECT_HIDDEN,
      [AUTOMATION_SEEN]: AUTOMATION_HIDDEN,
      [WS_SEEN]: WS_HIDDEN,
      [CHANNEL_SEEN]: CHANNEL_HIDDEN,
      [SKILL_SEEN]: SKILL_HIDDEN,
    };
    const swap = (v: unknown): unknown =>
      typeof v === "string"
        ? (hide[v] ?? v)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).map(([k, x]) => [
                k,
                swap(x),
              ])
            )
          : v;

    for (const c of cases) {
      const seen = await enrichOne(c.over);
      expect([c.field, seen[c.field]]).toEqual([c.field, c.seen]);
      const hidden = await enrichOne(swap(c.over) as Record<string, unknown>);
      expect([c.field, hidden[c.field]]).toEqual([c.field, undefined]);
    }
  });
});
