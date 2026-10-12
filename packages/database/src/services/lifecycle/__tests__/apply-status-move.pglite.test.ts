/**
 * The STATUS WRITE on a real Postgres (PGlite):
 *  - the columns move AND the read projection `properties[slug]` follows, in
 *    one statement;
 *  - an agent move is strict compare-and-set (stale ⇒ conflict, no write);
 *  - a human move with a stale belief WINS and says so (`staleExpected`,
 *    actual `from`);
 *  - an unknown option is refused; a no-op is `unchanged`;
 *  - a ROLE's status lands on its facet row, never on the entity.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeLifecyclePglite } from "./lifecycle-pglite.js";
import { declareLifecycle } from "../declare-lifecycle.js";
import {
  applyStatusMove,
  resolveStatusMoveTarget,
} from "../apply-status-move.js";
import { buildStoredConstraints } from "../../../utils/property-enum.js";
import * as schema from "../../../schema/index.js";

let h: Awaited<ReturnType<typeof makeLifecyclePglite>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let dealId: string;
let leadEntity: string;

const HUMAN = { kind: "human" as const, userId: "u1" };
const AGENT = { kind: "agent" as const, userId: "u1", agentUserId: "a1" };

async function kind(
  slug: string,
  propSlug: string,
  options: unknown[],
  role = false
) {
  const [p] = await db
    .insert(schema.profiles)
    .values({ slug, displayName: slug, profileKind: role ? "role" : "kind" })
    .returning();
  const [d] = await db
    .insert(schema.propertyDefs)
    .values({
      slug: propSlug,
      valueType: "string",
      profileId: p.id,
      constraints: buildStoredConstraints({ enumOptions: options }),
    })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId: p.id, propertyDefId: d.id });
  await declareLifecycle(db, { profileId: p.id, propertySlug: propSlug });
  return p.id as string;
}

async function entityRow(
  profileId: string,
  type: string,
  status: string | null
) {
  const [e] = await db
    .insert(schema.entities)
    .values({
      userId: "u1",
      profileId,
      type,
      status,
      properties: status ? { commercialStage: status, note: "keep" } : {},
    })
    .returning();
  return e.id as string;
}

async function target(entityId: string, role?: string) {
  const r = await resolveStatusMoveTarget(db, { entityId, role });
  if (!r.ok) throw new Error(r.reason);
  return r.target;
}

beforeAll(async () => {
  h = await makeLifecyclePglite();
  db = h.db;
  const deal = await kind("deal", "commercialStage", [
    { key: "draft", category: "open" },
    { key: "negotiating", category: "active" },
    { key: "won", category: "done", humanOnly: true },
    { key: "lost", category: "lost" },
  ]);
  dealId = await entityRow(deal, "deal", "draft");
  const person = await kind("person", "personState", [
    { key: "known", category: "open" },
  ]);
  const lead = await kind(
    "lead",
    "leadStage",
    [
      { key: "new", category: "open" },
      { key: "qualified", category: "done" },
    ],
    true
  );
  leadEntity = await entityRow(person, "person", null);
  await db.insert(schema.entityFacets).values({
    entityId: leadEntity,
    profileId: lead,
    userId: "u1",
    status: "new",
    properties: { leadStage: "new" },
  });
}, 120_000);
afterAll(async () => h?.pg.close());

async function row(id: string) {
  const [e] = await db
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, id));
  return e;
}

describe("applyStatusMove", () => {
  it("moves the column AND the read projection, keeping other properties", async () => {
    const r = await applyStatusMove(db, {
      target: await target(dealId),
      expectedFrom: "draft",
      to: "negotiating",
      actor: AGENT,
      sessionId: null,
    });
    expect(r.status).toBe("moved");
    if (r.status !== "moved") return;
    expect(r.transition).toMatchObject({
      from: "draft",
      to: "negotiating",
      fromCategory: "open",
      category: "active",
      property: "commercialStage",
      role: null,
      staleExpected: false,
      agentUserId: "a1",
    });
    const e = await row(dealId);
    expect(e.status).toBe("negotiating");
    expect(e.statusCategory).toBe("active");
    expect(e.properties).toEqual({
      commercialStage: "negotiating",
      note: "keep",
    });
  });

  it("an agent with a stale belief gets a conflict and writes nothing", async () => {
    const r = await applyStatusMove(db, {
      target: await target(dealId),
      expectedFrom: "draft",
      to: "lost",
      actor: AGENT,
    });
    expect(r).toEqual({
      status: "conflict",
      expectedFrom: "draft",
      actual: "negotiating",
    });
    expect((await row(dealId)).status).toBe("negotiating");
  });

  it("an agent loses a race between its read and its write", async () => {
    const t = await target(dealId); // read: negotiating
    await db
      .update(schema.entities)
      .set({ status: "draft" })
      .where(eq(schema.entities.id, dealId)); // someone moved it meanwhile
    const r = await applyStatusMove(db, {
      target: t,
      to: "lost",
      actor: AGENT,
    });
    expect(r.status).toBe("conflict");
    expect((await row(dealId)).status).toBe("draft");
  });

  it("an approval replay (strict) never overwrites a newer move, even as a person", async () => {
    const r = await applyStatusMove(db, {
      target: await target(dealId),
      expectedFrom: "negotiating",
      to: "won",
      actor: HUMAN,
      strict: true,
    });
    expect(r).toEqual({
      status: "conflict",
      expectedFrom: "negotiating",
      actual: "draft",
    });
    expect((await row(dealId)).status).toBe("draft");
  });

  it("a human move with a stale belief wins and records the actual from", async () => {
    const r = await applyStatusMove(db, {
      target: await target(dealId),
      expectedFrom: "negotiating",
      to: "won",
      actor: HUMAN,
    });
    expect(r.status).toBe("moved");
    if (r.status !== "moved") return;
    expect(r.transition.from).toBe("draft");
    expect(r.transition.staleExpected).toBe(true);
    expect((await row(dealId)).statusCategory).toBe("done");
  });

  it("refuses an unknown option; a move to the current value is unchanged", async () => {
    const t = await target(dealId);
    expect(
      (await applyStatusMove(db, { target: t, to: "closed", actor: HUMAN }))
        .status
    ).toBe("refused");
    expect(
      await applyStatusMove(db, { target: t, to: "won", actor: HUMAN })
    ).toEqual({ status: "unchanged", current: "won" });
  });

  it("a role's status lands on the facet row, never on the entity", async () => {
    const t = await target(leadEntity, "lead");
    expect(t.facetId).toBeTruthy();
    const r = await applyStatusMove(db, {
      target: t,
      expectedFrom: "new",
      to: "qualified",
      actor: HUMAN,
      lensWorkspaceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(r.status).toBe("moved");
    if (r.status !== "moved") return;
    expect(r.transition.role).toBe("lead");
    expect(r.transition.workspaceId).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    const [f] = await db
      .select()
      .from(schema.entityFacets)
      .where(eq(schema.entityFacets.id, t.facetId));
    expect(f.status).toBe("qualified");
    expect(f.statusCategory).toBe("done");
    expect(f.properties).toEqual({ leadStage: "qualified" });
    expect((await row(leadEntity)).status).toBeNull();
  });
});
