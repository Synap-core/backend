/**
 * A skill rewrite names the skill it rewrites and shows what each field holds
 * now, through `enrichProposalsForDisplay`: a `skill.update` and a composite's
 * `update_skill` op both read the skill row (`readSkillUpdateTargets`, floored
 * by `visibleSkillsWhere`). The values now are a before only while the
 * proposal is pending; a skill the viewer cannot read is never named or quoted.
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
import { enrichProposalsForDisplay } from "./display.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS = randomUUID();
const SKILL_SEEN = randomUUID();
const SKILL_HIDDEN = randomUUID();
const OLD_BODY = "## Creative director\nWrite the old way.";
const HIDDEN_NAME = "other-secret-skill";
const HIDDEN_BODY = "Other's secret instructions";

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
    `insert into workspaces (id, name, owner_id) values ($1,'Foundation',$2)`,
    [WS, VIEWER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, VIEWER]
  );
  await q(
    `insert into skills (id, user_id, scope, kind, name, body, metadata) values
       ($1,$2,'user','instruction','creative-director',$3,$4),
       ($5,$6,'user','instruction',$7,$8,null)`,
    [
      SKILL_SEEN,
      VIEWER,
      OLD_BODY,
      JSON.stringify({ allowedHosts: ["api.old.example"] }),
      SKILL_HIDDEN,
      OTHER,
      HIDDEN_NAME,
      HIDDEN_BODY,
    ]
  );
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
    ...over,
  } as never;
}

function skillUpdate(skillId: string, status = "pending") {
  return proposalRow({
    status,
    proposalType: "update",
    targetType: "skill",
    targetId: skillId,
    data: {
      requestId: randomUUID(),
      source: "intelligence",
      sourceId: VIEWER,
      workspaceId: WS,
      targetType: "skill",
      targetId: skillId,
      changeType: "update",
      data: {
        id: skillId,
        body: "## Creative director\nWrite the new way.",
        metadata: { allowedHosts: ["api.new.example"] },
      },
      summary: "Update Tool",
    },
  });
}

function compositeUpdate(skillId: string, status = "pending") {
  return proposalRow({
    status,
    proposalType: "create",
    targetType: "entity",
    targetId: randomUUID(),
    data: {
      operations: [
        {
          op: "update_skill",
          ref: "u1",
          skillId,
          patch: { body: "Write the new way." },
        },
      ],
    },
  });
}

type Review = {
  targetName?: string;
  changes: Array<{ path: string; before?: unknown; after?: unknown }>;
  graph?: {
    updates?: Array<{
      targetName?: string;
      fields: Array<{ key: string; value: string; before?: string }>;
    }>;
  };
};

async function reviewOf(row: never): Promise<Review> {
  const [out] = await enrichProposalsForDisplay([row], VIEWER);
  return (out as unknown as { review: Review }).review;
}

describe("a skill.update names its skill and shows what it holds now", () => {
  it("pending: the skill's name, and the body and hosts it holds now", async () => {
    const review = await reviewOf(skillUpdate(SKILL_SEEN));
    expect(review.targetName).toBe("creative-director");
    const body = review.changes.find((c) => c.path === "body");
    expect(body?.before).toBe(OLD_BODY);
    expect(body?.after).toBe("## Creative director\nWrite the new way.");
    const hosts = review.changes.find(
      (c) => c.path === "metadata.allowedHosts"
    );
    expect(hosts?.before).toEqual(["api.old.example"]);
  });

  it("applied: named, but the live row is no longer the before", async () => {
    const review = await reviewOf(skillUpdate(SKILL_SEEN, "approved"));
    expect(review.targetName).toBe("creative-director");
    const body = review.changes.find((c) => c.path === "body");
    expect(body?.before).toBeUndefined();
  });

  it("a skill the viewer cannot read is never named or quoted", async () => {
    const review = await reviewOf(skillUpdate(SKILL_HIDDEN));
    const body = review.changes.find((c) => c.path === "body");
    expect(body?.before).toBeUndefined();
    const text = JSON.stringify(review);
    expect(text).not.toContain(HIDDEN_NAME);
    expect(text).not.toContain(HIDDEN_BODY);
  });
});

describe("a composite update_skill names its skill and its before", () => {
  it("pending: targetName and each field's before", async () => {
    const review = await reviewOf(compositeUpdate(SKILL_SEEN));
    const update = review.graph?.updates?.[0];
    expect(update?.targetName).toBe("creative-director");
    expect(update?.fields[0]).toMatchObject({
      key: "body",
      value: "Write the new way.",
      before: OLD_BODY,
    });
  });

  it("applied: named, no before", async () => {
    const review = await reviewOf(compositeUpdate(SKILL_SEEN, "approved"));
    const update = review.graph?.updates?.[0];
    expect(update?.targetName).toBe("creative-director");
    expect(update?.fields[0]?.before).toBeUndefined();
  });

  it("a skill the viewer cannot read: neither name nor before", async () => {
    const review = await reviewOf(compositeUpdate(SKILL_HIDDEN));
    const update = review.graph?.updates?.[0];
    expect(update?.targetName).toBeUndefined();
    expect(update?.fields[0]?.before).toBeUndefined();
    expect(JSON.stringify(review)).not.toContain(HIDDEN_BODY);
  });
});
