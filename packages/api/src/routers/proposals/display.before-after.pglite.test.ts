/**
 * BEFORE / AFTER — the two review-model fields that tell a reviewer what an
 * approval will really do:
 *
 *   - UPDATE `changes[i].drift`: the propose-time snapshot (`previousData`)
 *     compared with the LIVE row. A field edited since the proposal was filed
 *     reads `changed_since`, so the before→after is not shown as current when
 *     its "before" is stale. `unknown` when either side is absent — never
 *     guessed. Measured only for a proposal not yet applied.
 *   - DELETE `removal`: what disappears with the target — property / link /
 *     role counts and the document — plus `recoverable`, which must be the
 *     SAME answer `revertableForRow` gives (soft entity delete → true,
 *     hard document delete → false).
 *
 * Driven through the REAL `enrichProposalsForDisplay` on PGlite, with the real
 * visibility predicates compiled to SQL — the entity batch, the grouped
 * relation count and the role-facet batch are all the production queries.
 *
 * What this CANNOT see: production Postgres constraints (PGlite tables here are
 * columns only), and `checkPermissionOrPropose` storing the capture — the
 * newly-set block calls the real `captureEntityPreviousData` and JSON
 * round-trips it; the first block writes `previousData` by hand in the shape
 * an OLDER capture stored (absent keys dropped).
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
import type { ProposalReviewModel } from "@synap-core/types";
import { enrichProposalsForDisplay } from "./display.js";
import { revertableForRow } from "./revert.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";
const WS_SEEN = randomUUID();
const WS_HIDDEN = randomUUID();
const id = () => randomUUID();

const ENTITY = id(); // visible, has a document, 3 filled properties
const ENTITY_HIDDEN = id(); // in a workspace the viewer is not a member of
const PEER_A = id();
const PEER_B = id();
const DOC = id();
const ROLE_CLIENT = id();
const ROLE_INVESTOR = id();

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

function proposalRow(over: Record<string, unknown>) {
  const now = new Date();
  return {
    id: id(),
    status: "pending",
    proposalType: "update",
    targetType: "entity",
    targetId: ENTITY,
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
  } as Record<string, unknown>;
}

async function reviewOf(over: Record<string, unknown>) {
  const row = proposalRow(over);
  const [enriched] = await enrichProposalsForDisplay([row as never], VIEWER);
  return {
    row,
    review: (enriched as unknown as { review: ProposalReviewModel }).review,
  };
}

const driftByPath = (review: ProposalReviewModel) =>
  Object.fromEntries(review.changes.map((c) => [c.path, c.drift]));

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
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
  // The LIVE entity: `status` has moved to "Paid" since the snapshot said
  // "Draft"; `amount` has not; `note` is an empty string (not a filled value).
  await q(
    `insert into entities (id, title, type, user_id, workspace_id, properties, document_id) values
      ($1,'Acme invoice','invoice',$2,$3,$4,$5),
      ($6,'Hidden thing','note',$7,$8,'{}',null),
      ($9,'Peer A','note',$2,$3,'{}',null),
      ($10,'Peer B','note',$2,$3,'{}',null)`,
    [
      ENTITY,
      VIEWER,
      WS_SEEN,
      JSON.stringify({ status: "Paid", amount: 5, tags: ["a"], note: "" }),
      DOC,
      ENTITY_HIDDEN,
      OTHER,
      WS_HIDDEN,
      PEER_A,
      PEER_B,
    ]
  );
  // Links touching ENTITY: two visible (one each direction), a visible
  // SELF-link (counts once), and one in a workspace the viewer cannot see.
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values
      ($1,$5,$6,$9,$10,'related'),
      ($2,$5,$6,$11,$9,'related'),
      ($3,$5,$6,$9,$9,'related'),
      ($4,$7,$8,$9,$10,'related')`,
    [
      id(),
      id(),
      id(),
      id(),
      VIEWER,
      WS_SEEN,
      OTHER,
      WS_HIDDEN,
      ENTITY,
      PEER_A,
      PEER_B,
    ]
  );
  await q(
    `insert into profiles (id, slug) values ($1,'client'),($2,'investor')`,
    [ROLE_CLIENT, ROLE_INVESTOR]
  );
  // One role in this proposal's lens; one in a workspace the viewer can't see.
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, properties) values
      ($1,$3,$4,$6,$7,'active','{}'),
      ($2,$3,$5,$8,$9,'active','{}')`,
    [
      id(),
      id(),
      ENTITY,
      ROLE_CLIENT,
      ROLE_INVESTOR,
      VIEWER,
      WS_SEEN,
      OTHER,
      WS_HIDDEN,
    ]
  );
});

// The request-shaped envelope `checkPermissionOrPropose` stores (the shape
// `isRequestShapedProposalData` recognises), payload nested under `data`.
const UPDATE_DATA = {
  requestId: "req-1",
  targetType: "entity",
  targetId: ENTITY,
  changeType: "update",
  data: {
    title: "Acme invoice (final)",
    properties: { status: "Done", amount: 7, dueDate: "2026-10-01" },
  },
  // The shape an OLDER `captureEntityPreviousData` stored: only touched keys; a
  // key that was absent was dropped by JSON (here: `dueDate`). Today's capture
  // records it as `null` — see "newly-set field" below.
  previousData: {
    title: "Acme invoice",
    properties: { status: "Draft", amount: 5 },
  },
};

describe("update drift — snapshot vs live", () => {
  it("marks a field edited since proposing as changed_since, an untouched one unchanged, a never-snapshotted one unknown", async () => {
    const { review } = await reviewOf({ data: UPDATE_DATA });
    expect(driftByPath(review)).toEqual({
      title: "unchanged",
      "properties.status": "changed_since",
      "properties.amount": "unchanged",
      "properties.dueDate": "unknown",
    });
    // The before shown is still the snapshot (not silently re-based)…
    const status = review.changes.find((c) => c.path === "properties.status");
    expect(status?.before).toBe("Draft");
  });

  it("is unknown when the live row is not readable (never guessed from the snapshot)", async () => {
    const { review } = await reviewOf({
      targetId: ENTITY_HIDDEN,
      data: { ...UPDATE_DATA, targetId: ENTITY_HIDDEN },
    });
    for (const c of review.changes) expect(c.drift).toBe("unknown");
  });

  it("is unknown for every field when the proposal carries no snapshot (legacy row)", async () => {
    const { previousData: _drop, ...legacy } = UPDATE_DATA;
    const { review } = await reviewOf({ data: legacy });
    for (const c of review.changes) expect(c.drift).toBe("unknown");
  });

  it("is not measured once the proposal applied (live = proposed by construction)", async () => {
    const { review } = await reviewOf({
      status: "approved",
      data: UPDATE_DATA,
    });
    expect(review.changes.length).toBeGreaterThan(0);
    for (const c of review.changes) expect(c).not.toHaveProperty("drift");
  });
});

/**
 * A NEWLY-SET field: absent at propose time. Driven from the REAL propose-time
 * capture (`captureEntityPreviousData`) on the live PGlite row, stored the way
 * the proposal row stores it (a JSON round-trip), then read back through
 * `enrichProposalsForDisplay` — nothing hand-built in between.
 */
describe("newly-set field — recorded as empty at propose time", () => {
  const FRESH = id();
  const payload = { properties: { stage: "Qualified", amount: 9 } };

  async function proposeOnFresh() {
    const { captureEntityPreviousData } =
      await import("../../utils/permission-check.js");
    const captured = await captureEntityPreviousData(
      "entity",
      "update",
      FRESH,
      payload
    );
    // What the jsonb column holds: `undefined` would vanish here.
    const previousData = JSON.parse(JSON.stringify(captured ?? null));
    return {
      previousData,
      data: {
        requestId: "req-fresh",
        targetType: "entity",
        targetId: FRESH,
        changeType: "update",
        data: payload,
        ...(previousData ? { previousData } : {}),
      },
    };
  }

  beforeAll(async () => {
    await q(
      `insert into entities (id, title, type, user_id, workspace_id, properties) values ($1,'Fresh lead','lead',$2,$3,$4)`,
      [FRESH, VIEWER, WS_SEEN, JSON.stringify({ amount: 9 })]
    );
  });

  it("the capture records the absent key as null ('was empty')", async () => {
    const { previousData } = await proposeOnFresh();
    expect(previousData).toEqual({ properties: { stage: null, amount: 9 } });
  });

  it("reads unchanged while still empty, and changed_since once someone set it — the before stays the snapshot's empty, never the live value", async () => {
    const { data } = await proposeOnFresh();
    const still = await reviewOf({ targetId: FRESH, data });
    expect(driftByPath(still.review)["properties.stage"]).toBe("unchanged");

    // Someone sets `stage` after the proposal was filed.
    await q(`update entities set properties = $2 where id = $1`, [
      FRESH,
      JSON.stringify({ amount: 9, stage: "Lost" }),
    ]);
    const { review } = await reviewOf({ targetId: FRESH, data });
    expect(driftByPath(review)).toEqual({
      "properties.stage": "changed_since",
      "properties.amount": "unchanged",
    });
    const stage = review.changes.find((c) => c.path === "properties.stage");
    expect(stage?.before).toBeNull();
    expect(stage?.before).not.toBe("Lost");
  });

  it("a legacy snapshot that DROPPED the key reads unknown with no before — never the live value", async () => {
    await q(`update entities set properties = $2 where id = $1`, [
      FRESH,
      JSON.stringify({ amount: 9, stage: "Lost" }),
    ]);
    const { review } = await reviewOf({
      targetId: FRESH,
      data: {
        requestId: "req-legacy",
        targetType: "entity",
        targetId: FRESH,
        changeType: "update",
        data: payload,
        previousData: { properties: { amount: 9 } },
      },
    });
    const stage = review.changes.find((c) => c.path === "properties.stage");
    expect(stage?.drift).toBe("unknown");
    expect(stage?.before).toBeUndefined();
  });

  it("a proposal with NO snapshot keeps today's live fallback (honestly unmeasured)", async () => {
    await q(`update entities set properties = $2 where id = $1`, [
      FRESH,
      JSON.stringify({ amount: 9, stage: "Lost" }),
    ]);
    const { review } = await reviewOf({
      targetId: FRESH,
      data: {
        requestId: "req-nosnap",
        targetType: "entity",
        targetId: FRESH,
        changeType: "update",
        data: payload,
      },
    });
    const stage = review.changes.find((c) => c.path === "properties.stage");
    expect(stage?.drift).toBe("unknown");
    expect(stage?.before).toBe("Lost");
  });
});

/**
 * WHICH RULE let a receipt run — `governanceRule` on an auto-approved row that
 * carries `_autoApprove.governanceRuleId`, floored like the rules editor's
 * `listAll` (pod-scope ∪ the viewer's workspaces).
 */
describe("receipt rule — which rule let it run", () => {
  const AGENT = "agent-scout";
  const AGENT_NAMELESS = "agent-nameless";
  // An agent NO row on the page names — its name must still be loaded.
  const AGENT_OFF_PAGE = "agent-ledger";
  const R_OFF_PAGE = id();
  const R_POD = id();
  const R_ANY = id();
  const R_HIDDEN = id();
  const R_NAMELESS = id();

  beforeAll(async () => {
    await q(
      `insert into users (id, name) values ($1,'Scout'),($2,null),($3,'Ledger')`,
      [AGENT, AGENT_NAMELESS, AGENT_OFF_PAGE]
    );
    await q(
      `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by, created_at) values
        ($1,'agent',$2,'pod',null,'action','entity.create','auto',$3,now())`,
      [R_OFF_PAGE, AGENT_OFF_PAGE, VIEWER]
    );
    await q(
      `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by, created_at) values
        ($1,'agent',$5,'pod',null,'action','entity.update','auto',$7,now()),
        ($2,'any',null,'workspace',$8,'action','entity.*','auto',$7,now()),
        ($3,'agent',$5,'workspace',$9,'action','entity.delete','auto',$10,now()),
        ($4,'agent',$6,'pod',null,'action','relation.create','auto',$7,now())`,
      [
        R_POD,
        R_ANY,
        R_HIDDEN,
        R_NAMELESS,
        AGENT,
        AGENT_NAMELESS,
        VIEWER,
        WS_SEEN,
        WS_HIDDEN,
        OTHER,
      ]
    );
  });

  const receipt = (governanceRuleId?: string) =>
    proposalRow({
      status: "auto_approved",
      agentUserId: AGENT,
      data: {
        ...UPDATE_DATA,
        _autoApprove: {
          matchedPattern: "entity.update",
          ...(governanceRuleId ? { governanceRuleId } : {}),
          approvedBy: "system:auto_approve",
        },
      },
    });
  const enrichedReceipt = async (governanceRuleId?: string) => {
    const [enriched] = await enrichProposalsForDisplay(
      [receipt(governanceRuleId) as never],
      VIEWER
    );
    return enriched as unknown as {
      governanceRule?: unknown;
      governanceRuleId?: unknown;
    };
  };
  const ruleOf = async (governanceRuleId?: string) =>
    (await enrichedReceipt(governanceRuleId)).governanceRule;

  it("names the rule by its pattern and the agent it trusts", async () => {
    expect(await ruleOf(R_POD)).toEqual({
      id: R_POD,
      targetPattern: "entity.update",
      agentName: "Scout",
    });
  });

  it("names an agent no row on the page loaded", async () => {
    expect(await ruleOf(R_OFF_PAGE)).toEqual({
      id: R_OFF_PAGE,
      targetPattern: "entity.create",
      agentName: "Ledger",
    });
  });

  it("carries the rule id top-level — read once, uuid only, even when the rule is unreadable", async () => {
    expect((await enrichedReceipt(R_POD)).governanceRuleId).toBe(R_POD);
    // The viewer may not read this rule: its id still says "a rule ran it".
    const hidden = await enrichedReceipt(R_HIDDEN);
    expect(hidden.governanceRuleId).toBe(R_HIDDEN);
    expect(hidden.governanceRule).toBeUndefined();
    // Not a uuid → no id; no rule → no id.
    expect(await enrichedReceipt("rule-1")).not.toHaveProperty(
      "governanceRuleId"
    );
    expect(await enrichedReceipt()).not.toHaveProperty("governanceRuleId");
  });

  it("a rule for anyone carries no agent; a nameless agent carries no name (never its id)", async () => {
    expect(await ruleOf(R_ANY)).toEqual({
      id: R_ANY,
      targetPattern: "entity.*",
    });
    const nameless = await ruleOf(R_NAMELESS);
    expect(nameless).toEqual({
      id: R_NAMELESS,
      targetPattern: "relation.create",
    });
    expect(JSON.stringify(nameless)).not.toContain(AGENT_NAMELESS);
  });

  it("is ABSENT for a rule in a workspace the viewer cannot see, an unknown rule, and a receipt with no rule", async () => {
    expect(await ruleOf(R_HIDDEN)).toBeUndefined();
    expect(await ruleOf(id())).toBeUndefined();
    expect(await ruleOf()).toBeUndefined();
  });
});

describe("delete removal — what disappears", () => {
  it("counts filled properties, visible links, the document and the in-lens roles of an entity delete", async () => {
    const { review, row } = await reviewOf({
      proposalType: "delete",
      data: { changeType: "delete" },
    });
    expect(review.removal).toEqual({
      name: "Acme invoice",
      kind: "invoice",
      entityId: ENTITY,
      propertyCount: 3,
      relationCount: 3,
      hasDocument: true,
      documentId: DOC,
      roles: ["Client"],
      recoverable: true,
    });
    expect(review.removal!.recoverable).toBe(revertableForRow(row as never));
    // A delete carries no drift — nothing is before/after.
    for (const c of review.changes) expect(c).not.toHaveProperty("drift");
  });

  it("a document delete is hard: recoverable false (same as the planner), no entity counts", async () => {
    const { review, row } = await reviewOf({
      proposalType: "delete",
      targetType: "document",
      targetId: DOC,
      data: { changeType: "delete" },
    });
    expect(review.removal).toMatchObject({
      kind: "document",
      recoverable: false,
    });
    expect(review.removal!.recoverable).toBe(revertableForRow(row as never));
    expect(review.removal).not.toHaveProperty("propertyCount");
    expect(review.removal).not.toHaveProperty("relationCount");
  });

  it("an entity the viewer cannot read gets NO counts — absent, never 0", async () => {
    const { review } = await reviewOf({
      proposalType: "delete",
      targetId: ENTITY_HIDDEN,
      data: { changeType: "delete" },
    });
    expect(review.removal).toEqual({ kind: "entity", recoverable: true });
  });

  it("a non-delete carries no removal", async () => {
    const { review } = await reviewOf({ data: UPDATE_DATA });
    expect(review).not.toHaveProperty("removal");
  });
});
