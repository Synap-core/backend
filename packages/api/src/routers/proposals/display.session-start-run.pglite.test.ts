/**
 * READ time — a propose-mode rule's run on a playbook (`targetType:
 * "playbook"`, `proposalType: "run"`, the live pod row 20f59d28) is a SESSION
 * START: `enrichProposalsForDisplay` names it by the session it creates
 * (`buildRunSessionStartTitle`, the same derivation the pod names the session
 * with on approval), resolves its subjects for the review's doors, and names
 * the RULE that filed it from the envelope's `automationId`.
 *
 * Driven on PGlite with the real access predicates compiled to SQL. A subject
 * outside the proposal's lens is never named.
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
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const PB_SEEN = randomUUID();
const PB_HIDDEN = randomUUID();
const HIDDEN_NAME = "Other's secret template";
const RULE = randomUUID();
const ACME = randomUUID();
const BETA = randomUUID();
const HIDDEN_LEAD = randomUUID();
const HIDDEN_LEAD_NAME = "Somebody else's lead";

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
    `insert into workspaces (id, name, owner_id) values ($1,'Foundation',$3),($2,'Hidden WS',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), WS_SEEN, VIEWER, randomUUID(), WS_HIDDEN, OTHER]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, status) values ($1,$2,$3,'Qualify a lead','g','active'),($4,$5,$6,$7,'g','active')`,
    [PB_SEEN, WS_SEEN, VIEWER, PB_HIDDEN, WS_HIDDEN, OTHER, HIDDEN_NAME]
  );
  await q(
    `insert into automations (id, workspace_id, created_by, name) values ($1,$2,$3,'New lead → qualify')`,
    [RULE, WS_SEEN, VIEWER]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title) values ($1,$4,$5,'lead','Acme Corp'),($2,$4,$5,'lead','Beta Ltd'),($3,$6,$7,'lead',$8)`,
    [ACME, BETA, HIDDEN_LEAD, VIEWER, WS_SEEN, OTHER, WS_HIDDEN, HIDDEN_LEAD_NAME]
  );
});


function runRow(payload: Record<string, unknown>, envelope: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "pending",
    proposalType: "run",
    targetType: "playbook",
    targetId: PB_SEEN,
    data: {
      targetType: "playbook",
      targetId: PB_SEEN,
      changeType: "run",
      data: { playbookId: PB_SEEN, params: {}, ...payload },
      source: "automation",
      automationId: RULE,
      automationRunId: randomUUID(),
      ...envelope,
    },
    workspaceId: WS_SEEN,
    projectId: null,
    threadId: null,
    sessionId: null,
    correlationId: null,
    agentUserId: null,
    subjectUserId: VIEWER,
    createdBy: VIEWER,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
  } as never;
}

type Out = {
  review: { summary?: string; reasoning?: string };
  request: { reasoning?: string };
  subjectName?: string;
  subjectKind?: string;
  subjects?: Array<{ id: string; name: string | null; kind: string | null }>;
  automationName?: string;
  automationId?: string;
  automationRunId?: string;
  policyReason?: string;
  playbookName?: string;
};

async function enrich(row: never): Promise<Out> {
  const [out] = await enrichProposalsForDisplay([row], VIEWER);
  return out as unknown as Out;
}

describe("a rule's run on a playbook reads as the session it starts", () => {
  it("is titled by the session's own name and names its subject and rule", async () => {
    const out = await enrich(runRow({ subjectId: ACME }));
    expect(out.review.summary).toBe("Qualify a lead · Acme Corp");
    expect(out.subjectName).toBe("Acme Corp");
    expect(out.subjectKind).toBe("lead");
    expect(out.subjects).toEqual([{ id: ACME, name: "Acme Corp", kind: "lead" }]);
    expect(out.automationName).toBe("New lead → qualify");
    expect(out.automationId).toBe(RULE);
    expect(out.playbookName).toBe("Qualify a lead");
  });

  it("outranks the rule's stored batch sentence and counts the batch", async () => {
    const out = await enrich(
      runRow(
        { subjectId: ACME, subjectIds: [ACME, BETA, HIDDEN_LEAD] },
        { summary: 'Run Template "Qualify a lead" for 3 new leads' }
      )
    );
    expect(out.review.summary).toBe("Qualify a lead · Acme Corp + 2 more");
    expect(out.subjects?.map((s) => s.id)).toEqual([ACME, BETA, HIDDEN_LEAD]);
  });

  it("never names a subject outside the proposal's lens", async () => {
    const out = await enrich(runRow({ subjectId: HIDDEN_LEAD }));
    expect(out.review.summary).toBe("Qualify a lead");
    expect(out.subjectName).toBeUndefined();
    expect(out.subjects).toEqual([{ id: HIDDEN_LEAD, name: null, kind: null }]);
    expect(JSON.stringify(out)).not.toContain(HIDDEN_LEAD_NAME);
  });
});

describe("the rule behind a proposal and the pod's own words", () => {
  it("names the rule from the envelope's run when only the run is stamped", async () => {
    const run = randomUUID();
    await q(
      `insert into automation_runs (id, automation_id, workspace_id, status) values ($1,$2,$3,'completed')`,
      [run, RULE, WS_SEEN]
    );
    const out = await enrich(
      runRow({ subjectId: ACME }, { automationId: undefined, automationRunId: run })
    );
    expect(out.automationId).toBe(RULE);
    expect(out.automationRunId).toBe(run);
    expect(out.automationName).toBe("New lead → qualify");
  });

  it("moves a system sentence stored as reasoning into policyReason", async () => {
    const out = await enrich(
      runRow(
        { subjectId: ACME },
        {
          reasoning:
            "A rule set to propose matched — it asks before starting this playbook.",
        }
      )
    );
    expect(out.policyReason).toBe(
      "A rule set to propose matched — it asks before starting this playbook."
    );
    expect(out.request.reasoning).toBeUndefined();
    expect(out.review.reasoning).toBeUndefined();
  });

  it("keeps a proposer's own reasoning as the WHY and reads a stored policyReason", async () => {
    const out = await enrich(
      runRow(
        { subjectId: ACME },
        {
          reasoning: "Acme asked for a demo",
          policyReason: "Automation proposed creating an entity.",
        }
      )
    );
    expect(out.review.reasoning).toBe("Acme asked for a demo");
    expect(out.policyReason).toBe("Automation proposed creating an entity.");
  });
});
