/**
 * S5 — undoing a proposal that wrote a dependency edge announces the removal
 * on the event spine (`link.delete.completed`), exactly like the forward write
 * announced its creation. Driven through the REAL `revertProposalCreations` →
 * `safeRevert` on PGlite; only the event writer is captured.
 *
 * Pins: a rule on `link.delete` also sees an undo. A non-dependency link the
 * same undo removes emits nothing new (the forward write never emitted either).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
const mutations = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("../../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async (o: Record<string, unknown>) => {
    mutations.push(o);
    return null;
  }),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { revertProposalCreations } from "../../proposals/revert-creations.js";

const USER = "user-1";
const DEP = randomUUID();
const OTHER_LINK = randomUUID();
const A = randomUUID();
const B = randomUUID();
const PROPOSAL = randomUUID();

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

let client: PGlite;
beforeAll(async () => {
  client = new PGlite();
  holder.db = drizzle(client, { schema });
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  await client.query(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_by, created_at)
     values ($1,null,'entity',$3,'entity',$4,'blocked_by','{}',$5, now()),
            ($2,null,'entity',$3,'tool',$4,'about','{}',$5, now())`,
    [DEP, OTHER_LINK, A, B, USER]
  );
});

describe("undo of a dependency edge", () => {
  it("emits link.delete for the dependency it removed (and only for it)", async () => {
    const outcome = await revertProposalCreations({
      proposal: { id: PROPOSAL, workspaceId: null, sessionId: null, data: {} },
      plan: {
        kind: "delete-creations",
        entityIds: [],
        relationIds: [],
        documentIds: [],
        facetIds: [],
        skillIds: [],
        automationIds: [],
        ruleIds: [],
        propertyDiffs: [],
        linkIds: [DEP, OTHER_LINK],
      },
      userId: USER,
    });
    expect(outcome.undone.linkIds).toEqual(
      expect.arrayContaining([DEP, OTHER_LINK])
    );
    await new Promise((r) => setTimeout(r, 0));
    const linkEvents = mutations.filter((m) => m.subjectType === "link");
    expect(linkEvents).toEqual([
      expect.objectContaining({
        subjectType: "link",
        action: "delete",
        subjectId: DEP,
        userId: USER,
        proposalId: PROPOSAL,
        data: expect.objectContaining({
          linkType: "blocked_by",
          fromId: A,
          toId: B,
        }),
      }),
    ]);
  });
});
