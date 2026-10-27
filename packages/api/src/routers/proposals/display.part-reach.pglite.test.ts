/**
 * A mixed proposal's automation says what its steps can reach, through
 * `enrichProposalsForDisplay`: each `capability` step resolves to the skill
 * the run door would call (`answeringSkillsWhere`, approved first), each
 * `skill` step to its skill by id, each written-out URL to its host. A step
 * it cannot read (a verb this viewer cannot see, a URL built at run time) is
 * counted as unread, never folded into "reaches nothing". A code skill also
 * reaches the connections its code calls through `callProvider` (a provider
 * the code does not write out is counted as unread). An `update_skill` says
 * what the skill it rewrites can reach.
 *
 * Driven on PGlite with the real skill read rule compiled to SQL.
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
import { resolveServiceName } from "@synap-core/types/service-marks";
import { enrichProposalsForDisplay } from "./display.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS = randomUUID();
const CODE_SKILL = randomUUID();

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

async function skill(row: {
  id?: string;
  userId?: string;
  kind: string;
  name: string;
  approved?: boolean;
  updatedAt?: string;
  metadata?: unknown;
  providerSpec?: unknown;
  code?: string;
}) {
  await q(
    `insert into skills (id, user_id, scope, kind, name, status, approved, updated_at, metadata, provider_spec, code)
     values ($1,$2,'user',$3,$4,'active',$5,$6,$7,$8,$9)`,
    [
      row.id ?? randomUUID(),
      row.userId ?? VIEWER,
      row.kind,
      row.name,
      row.approved ?? true,
      row.updatedAt ?? "2026-10-01T00:00:00Z",
      row.metadata === undefined ? null : JSON.stringify(row.metadata),
      row.providerSpec === undefined ? null : JSON.stringify(row.providerSpec),
      row.code ?? null,
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Foundation',$2)`,
    [WS, VIEWER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, VIEWER]
  );
  // A provider verb: it calls Apify through the pod's connection.
  await skill({
    kind: "declarative",
    name: "apify.run_actor",
    providerSpec: { tool: "apify", method: "POST", pathTemplate: "/acts" },
  });
  // Two skills answer `lookup`: the run door picks the APPROVED one, though
  // the unapproved shadow is newer.
  await skill({
    kind: "code",
    name: "lookup",
    approved: true,
    updatedAt: "2026-09-01T00:00:00Z",
    metadata: { allowedHosts: ["good.example"] },
  });
  await skill({
    kind: "code",
    name: "lookup",
    approved: false,
    updatedAt: "2026-10-20T00:00:00Z",
    metadata: { allowedHosts: ["shadow.example"] },
  });
  // A code skill a `skill` step names by id.
  await skill({
    id: CODE_SKILL,
    kind: "code",
    name: "score_lead",
    metadata: { allowedHosts: ["api.scoring.example"] },
  });
  // Another person's skill: this viewer's steps cannot run it.
  await skill({
    userId: OTHER,
    kind: "code",
    name: "secret_verb",
    metadata: { allowedHosts: ["secret.example"] },
  });
  // Runs in the pod.
  await skill({ kind: "builtin", name: "entity_facet.attach" });
  // A code skill that calls Apify through the pod (no allowed host of its
  // own): the shape of the pod's real apify_run_actor.
  await skill({
    kind: "code",
    name: "run_actor_code",
    metadata: {},
    code: `const r = await callProvider("apify_api", "POST", "/acts/x/runs", input);
const again = await callProvider('apify_api', 'GET', "/runs/1");
return r;`,
  });
  // A code skill whose provider is chosen at run time.
  await skill({
    kind: "code",
    name: "any_provider",
    metadata: {},
    code: `return await callProvider(input.provider, "GET", "/x");`,
  });
});

function proposalRow(over: Record<string, unknown>) {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "pending",
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
    proposalType: "create",
    targetType: "entity",
    targetId: randomUUID(),
    ...over,
  } as never;
}

function automation(
  nodes: Array<{ type: string; data: Record<string, unknown> }>,
  status = "pending"
) {
  return proposalRow({
    status,
    data: {
      operations: [
        {
          op: "create_automation",
          ref: "beh1",
          name: "Scrape new leads",
          triggerType: "cron",
          flowDefinition: {
            nodes: [
              { id: "t", type: "trigger", data: {} },
              ...nodes.map((n, i) => ({ id: `n${i}`, ...n })),
            ],
            edges: [],
          },
        },
      ],
    },
  });
}

type Reach = { hosts: string[]; connections: string[]; unreadSteps: number };
type Review = {
  graph?: {
    automations?: Array<{ reach?: Reach }>;
    updates?: Array<{ reach?: Reach }>;
  };
};

async function reviewOf(row: never): Promise<Review> {
  const [out] = await enrichProposalsForDisplay([row], VIEWER);
  return (out as unknown as { review: Review }).review;
}

describe("an automation in a mixed proposal says what its steps reach", () => {
  it("resolves each step the way the run would, and names its hosts", async () => {
    const review = await reviewOf(
      automation([
        { type: "capability", data: { verbId: "apify.run_actor" } },
        { type: "capability", data: { verbId: "lookup" } },
        { type: "skill", data: { skillId: CODE_SKILL } },
        { type: "fetch", data: { url: "https://hooks.example/in" } },
        {
          type: "output",
          data: {
            outputType: "webhook",
            config: { url: "https://notify.example/x" },
          },
        },
        { type: "output", data: { outputType: "facet_attach", config: {} } },
      ])
    );
    expect(review.graph?.automations?.[0]?.reach).toEqual({
      hosts: [
        "api.scoring.example",
        "good.example",
        "hooks.example",
        "notify.example",
      ],
      connections: ["Apify"],
      unreadSteps: 0,
    });
    expect(JSON.stringify(review)).not.toContain("shadow.example");
  });

  it("a step it cannot read is counted, never read as nothing", async () => {
    const review = await reviewOf(
      automation([
        { type: "capability", data: { verbId: "secret_verb" } },
        { type: "capability", data: { verbId: "no_such_verb" } },
        { type: "fetch", data: { url: "https://{{trigger.host}}/in" } },
        { type: "sub_automation", data: { automationId: randomUUID() } },
      ])
    );
    expect(review.graph?.automations?.[0]?.reach).toEqual({
      hosts: [],
      connections: [],
      unreadSteps: 4,
    });
    expect(JSON.stringify(review)).not.toContain("secret.example");
  });

  it("a code skill reaches the connections its code calls through the pod", async () => {
    const review = await reviewOf(
      automation([{ type: "capability", data: { verbId: "run_actor_code" } }])
    );
    expect(review.graph?.automations?.[0]?.reach).toEqual({
      hosts: [],
      connections: [resolveServiceName("apify_api")],
      unreadSteps: 0,
    });
  });

  it("a provider the code does not write out is counted, never read as nothing", async () => {
    const review = await reviewOf(
      automation([{ type: "capability", data: { verbId: "any_provider" } }])
    );
    expect(review.graph?.automations?.[0]?.reach).toEqual({
      hosts: [],
      connections: [],
      unreadSteps: 1,
    });
  });

  it("a builtin step runs in the pod: measured, reaches nothing", async () => {
    const review = await reviewOf(
      automation([
        { type: "capability", data: { verbId: "entity_facet.attach" } },
      ])
    );
    expect(review.graph?.automations?.[0]?.reach).toEqual({
      hosts: [],
      connections: [],
      unreadSteps: 0,
    });
  });

  it("decided: not measured, so no reach is drawn", async () => {
    const review = await reviewOf(
      automation(
        [{ type: "capability", data: { verbId: "apify.run_actor" } }],
        "approved"
      )
    );
    expect(review.graph?.automations?.[0]).toBeDefined();
    expect(review.graph?.automations?.[0]?.reach).toBeUndefined();
  });
});

describe("an update_skill says what the skill it rewrites can reach", () => {
  it("pending: the code skill's allowed hosts", async () => {
    const review = await reviewOf(
      proposalRow({
        data: {
          operations: [
            {
              op: "update_skill",
              ref: "u1",
              skillId: CODE_SKILL,
              patch: { description: "Scores a lead" },
            },
          ],
        },
      })
    );
    expect(review.graph?.updates?.[0]?.reach).toEqual({
      hosts: ["api.scoring.example"],
      connections: [],
      unreadSteps: 0,
    });
  });
});
