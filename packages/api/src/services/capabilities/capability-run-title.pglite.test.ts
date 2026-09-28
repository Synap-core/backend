/**
 * CAPABILITY-RUN TITLES — a proposal to run a core entity verb is titled as the
 * action on its object (`Delete Question "GRP #3: Numbers"`), not "Run
 * entity.delete", at BOTH ends:
 *
 *   - WRITE: `resolveEntityVerbRunSubject` → `describeCapabilityRun` (the
 *     stored `data.summary`), floored by the entity VisibilityRule;
 *   - READ: `enrichProposalsForDisplay` re-derives a LEGACY row whose stored
 *     summary is exactly the generated "Run <verbId>" shape, and hoists the
 *     run's `parameters.reasoning` to where the card reads it.
 *
 * Driven on PGlite with the real access predicates compiled to SQL — nothing
 * between the stored row and the title is hand-built.
 *
 * What this CANNOT see: production Postgres (PGlite tables carry no FKs /
 * enums), and the review CARD, which composes its own title
 * (`useProposalPresentation`, synap-app, tested there).
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
import { entityVerbRunTarget } from "@synap-core/types/proposals/capability-run";
import { resolveEntityVerbRunSubject } from "./capability-run-subject.js";
import { describeCapabilityRun } from "./execute-capability.js";
import { enrichProposalsForDisplay } from "../../routers/proposals/display.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const Q_SEEN = randomUUID();
const Q_HIDDEN = randomUUID();
const HIDDEN_TITLE = "Other's secret question";

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
    `insert into entities (id, title, type, user_id, workspace_id) values ($1,'GRP #3: Numbers','question',$2,$3),($4,$5,'question',$6,$7)`,
    [Q_SEEN, VIEWER, WS_SEEN, Q_HIDDEN, HIDDEN_TITLE, OTHER, WS_HIDDEN]
  );
});

const REASON = "superseded by the Génération/Rémunération/Partage set";

describe("write time — the stored summary names the action on the object", () => {
  it('a visible target: Delete Question "GRP #3: Numbers"', async () => {
    const params = { entityId: Q_SEEN, reasoning: REASON };
    const subject = await resolveEntityVerbRunSubject(
      entityVerbRunTarget("entity.delete", params),
      VIEWER
    );
    expect(describeCapabilityRun("entity.delete", params, subject)).toBe(
      'Delete Question "GRP #3: Numbers"'
    );
  });

  it("a target the proposer cannot see: no name, no kind (never an oracle)", async () => {
    const params = { entityId: Q_HIDDEN };
    const subject = await resolveEntityVerbRunSubject(
      entityVerbRunTarget("entity.delete", params),
      VIEWER
    );
    expect(subject).toBeUndefined();
    expect(describeCapabilityRun("entity.delete", params, subject)).toBe(
      "Delete entity"
    );
  });

  it("any other verb keeps its own title", () => {
    expect(describeCapabilityRun("gmail_send", { to: "a@b.c" })).toBe(
      "Run gmail_send"
    );
  });
});

function runRow(over: {
  summary: string;
  entityId: string;
  reasoning?: string;
}) {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "pending",
    proposalType: "capability.run",
    targetType: "capability",
    targetId: randomUUID(),
    data: {
      verbId: "entity.delete",
      skillId: randomUUID(),
      summary: over.summary,
      parameters: {
        entityId: over.entityId,
        ...(over.reasoning ? { reasoning: over.reasoning } : {}),
      },
      workspaceId: WS_SEEN,
    },
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
  } as never;
}

async function enrich(row: never) {
  const [out] = await enrichProposalsForDisplay([row], VIEWER);
  return out as unknown as {
    request: { summary?: string; reasoning?: string };
    review: { summary?: string; reasoning?: string };
  };
}

describe('read time — legacy "Run entity.delete" rows re-derive', () => {
  it("names the object on the request AND the review model, and shows the reason", async () => {
    const out = await enrich(
      runRow({
        summary: "Run entity.delete",
        entityId: Q_SEEN,
        reasoning: REASON,
      })
    );
    expect(out.review.summary).toBe('Delete Question "GRP #3: Numbers"');
    expect(out.request.summary).toBe('Delete Question "GRP #3: Numbers"');
    expect(out.review.reasoning).toBe(REASON);
  });

  it("a hidden target never leaks its name through the re-derivation", async () => {
    const out = await enrich(
      runRow({ summary: "Run entity.delete", entityId: Q_HIDDEN })
    );
    expect(out.review.summary).toBe("Delete entity");
    expect(JSON.stringify(out)).not.toContain(HIDDEN_TITLE);
  });

  it("a summary someone WROTE is never rewritten", async () => {
    const out = await enrich(
      runRow({ summary: "Retire the old GRP #3", entityId: Q_SEEN })
    );
    expect(out.review.summary).toBe("Retire the old GRP #3");
  });
});
