/**
 * A tool run reads as the CALL it makes, through `enrichProposalsForDisplay`:
 * `review.toolRun` carries its action, the tool it declares and every
 * argument the agent passed, with the skill's schema words. The skill and the
 * tool are read under the viewer's read rules (`readToolRuns`); a skill the
 * viewer cannot read still yields the call, named from its verb, with
 * nothing of the skill's own. Founder dogfood 2026-10-30, proposal 4b5e040e:
 * the review drew "Run Tool" and the argument NAMES only.
 *
 * Driven on PGlite with the real skill and tool read rules compiled to SQL.
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
import type { ProposalToolRun } from "@synap-core/types/proposals/capability-run";
import { enrichProposalsForDisplay } from "./display.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS = randomUUID();
const SKILL_SEEN = randomUUID();
const SKILL_HIDDEN = randomUUID();
const TOOL = randomUUID();
const HIDDEN_DESCRIPTION = "Other's private verb";

const PARAMETERS = {
  name: "sillage",
  image: "ubuntu-24.04",
  location: "nbg1",
  userData: "#cloud-config\npackage_update: true\n",
  serverType: "cx23",
  apiToken: "tok_live_123",
};

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Builder',$2)`,
    [WS, VIEWER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, VIEWER]
  );
  await q(
    `insert into skills (id, user_id, scope, kind, name, description, parameters) values
       ($1,$2,'user','declarative','hcloud_create_server','Create a server on Hetzner Cloud',$3),
       ($4,$5,'user','declarative','hcloud_create_server',$6,null)`,
    [
      SKILL_SEEN,
      VIEWER,
      JSON.stringify({
        type: "object",
        properties: {
          serverType: { type: "string", description: "Hetzner server type" },
          name: { type: "string", title: "Server name" },
        },
      }),
      SKILL_HIDDEN,
      OTHER,
      HIDDEN_DESCRIPTION,
    ]
  );
  await q(
    `insert into tools (id, workspace_id, created_by, name, kind) values ($1,$2,$3,'hetzner_cloud','api')`,
    [TOOL, WS, VIEWER]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,'skill',$2,'tool',$3,'requires')`,
    [randomUUID(), SKILL_SEEN, TOOL]
  );
});

function runRow(data: Record<string, unknown>, status = "pending") {
  const now = new Date();
  return {
    id: randomUUID(),
    status,
    workspaceId: WS,
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
    proposalType: "capability.run",
    targetType: "capability",
    targetId: typeof data.skillId === "string" ? data.skillId : randomUUID(),
    data: { workspaceId: WS, summary: "Run hcloud create server", ...data },
  } as never;
}

async function toolRunOf(row: never): Promise<ProposalToolRun | undefined> {
  const [out] = await enrichProposalsForDisplay([row], VIEWER);
  return (out as unknown as { review: { toolRun?: ProposalToolRun } }).review
    .toolRun;
}

describe("a capability.run reads as the call it makes", () => {
  it("its action, its tool, and every argument's value in the schema's words", async () => {
    const run = await toolRunOf(
      runRow({
        skillId: SKILL_SEEN,
        verbId: "hcloud_create_server",
        parameters: PARAMETERS,
      })
    );
    expect(run?.action).toBe("Create server");
    expect(run?.tool).toBe("Hetzner cloud");
    expect(run?.description).toBe("Create a server on Hetzner Cloud");
    expect(run?.parameters.map((p) => p.key)).toEqual([
      "serverType",
      "name",
      "image",
      "location",
      "userData",
      "apiToken",
    ]);
    const byKey = new Map(run!.parameters.map((p) => [p.key, p]));
    expect(byKey.get("serverType")).toEqual({
      key: "serverType",
      label: "Server type",
      description: "Hetzner server type",
      value: "cx23",
    });
    expect(byKey.get("name")?.label).toBe("Server name");
    expect(byKey.get("userData")?.value).toBe(PARAMETERS.userData);
  });

  it("a decided run still reads as its call", async () => {
    const run = await toolRunOf(
      runRow(
        {
          skillId: SKILL_SEEN,
          verbId: "hcloud_create_server",
          parameters: PARAMETERS,
        },
        "approval_failed"
      )
    );
    expect(run?.action).toBe("Create server");
  });

  it("a credential-named argument is marked secret and its value never leaves the pod", async () => {
    const run = await toolRunOf(
      runRow({
        skillId: SKILL_SEEN,
        verbId: "hcloud_create_server",
        parameters: PARAMETERS,
      })
    );
    const token = run!.parameters.find((p) => p.key === "apiToken");
    expect(token?.secret).toBe(true);
    expect(token).not.toHaveProperty("value");
    expect(JSON.stringify(run)).not.toContain("tok_live_123");
  });

  it("a skill the viewer cannot read: the call from its verb, nothing of the skill", async () => {
    const run = await toolRunOf(
      runRow({
        skillId: SKILL_HIDDEN,
        verbId: "hcloud_create_server",
        parameters: { name: "sillage" },
      })
    );
    expect(run?.action).toBe("Create server");
    expect(run?.tool).toBeUndefined();
    expect(run?.description).toBeUndefined();
    expect(run?.parameters).toEqual([
      { key: "name", label: "Name", value: "sillage" },
    ]);
    expect(JSON.stringify(run)).not.toContain(HIDDEN_DESCRIPTION);
  });

  it("a core entity verb on one entity is titled as its action, not drawn as a call", async () => {
    const run = await toolRunOf(
      runRow({
        verbId: "entity.delete",
        parameters: { entityId: randomUUID() },
      })
    );
    expect(run).toBeUndefined();
  });
});
