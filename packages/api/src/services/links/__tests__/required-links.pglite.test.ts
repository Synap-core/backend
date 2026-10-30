/**
 * Required links (a template's `entityLinks[].required`) answered on PGlite,
 * every query compiled and run as SQL: the create check, the capture-graph
 * check, the relation door's undeclared-pair warning and template health's
 * per-space debt.
 *
 * The CRM shape of research R3 (2469006b): `outreach-touch` must carry
 * `relates_to` to a person OR a company (required by template crm), and
 * declares `sent_to` → person only. Rows, each ruling out a wrong rule:
 *  - a touch with `relates_to` to a person is not in debt; one with
 *    `relates_to` to a NOTE is (rules out "any edge of the type counts");
 *  - a deleted touch is not counted (rules out counting dead rows);
 *  - a link not marked required (`sent_to`) never warns on create;
 *  - `sent_to` → company warns at the relation door, → person does not, and a
 *    kind that declares no link of the type (note `relates_to` person) stays
 *    quiet (rules out "every undeclared pair warns");
 *  - a graph whose own edge carries the link does not warn (the brief's "a
 *    create with its links in the same call must not warn");
 *  - a create whose entity_id property syncs to the required relation is
 *    clear, while one whose synced property points to a note, or is unset,
 *    still warns (rules out "the door's own edges are never counted" AND "any
 *    synced property counts");
 *  - template health matches both ends by kind SLUG: in a third space, a row
 *    of a workspace COPY of the touch kind with no edge is debt, a touch
 *    linked to a workspace copy of `company` is not, and the copy's own mark
 *    does not count a row twice (rules out matching by profile id at either
 *    end, and one debt line per copy of a rule).
 *
 * What this CANNOT see: production Postgres constraints (no FKs or NOT NULL
 * here), and the doors' wiring (create door: create.required-links test; hub
 * reply: entities.create-receipt test).
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
  const schemaModule = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schemaModule });
  return { ...actual, db, getDb: async () => db };
});

import * as schema from "@synap/database/schema";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { missingLinkWarning } from "@synap-core/types/proposals";
import {
  checkRequiredLinksForCreate,
  checkRequiredLinksForGraph,
  requiredLinkDebtByWorkspace,
  undeclaredLinkWarning,
} from "../required-links.js";

const USER = "user-required-links";
const WS = randomUUID();
const OTHER_WS = randomUUID();
const COPY_WS = randomUUID(); // a space with its own copies of two kinds
const ids = {
  touchKind: randomUUID(),
  person: randomUUID(),
  company: randomUUID(),
  note: randomUUID(),
  relatesTo: randomUUID(),
  sentTo: randomUUID(),
  touchCopy: randomUUID(), // outreach-touch, copied into COPY_WS
  companyCopy: randomUUID(), // company, copied into COPY_WS
};
const ADA = randomUUID(); // a person
const ACME = randomUUID(); // a company
const MEMO = randomUUID(); // a note
const LINKED = randomUUID(); // touch → relates_to → person
const WRONG_KIND = randomUUID(); // touch → relates_to → note
const BARE = randomUUID(); // touch with no edge
const DELETED = randomUUID(); // deleted touch with no edge
const ELSEWHERE = randomUUID(); // touch in another space, no edge
const COPY_BARE = randomUUID(); // copy-kind touch, no edge
const TO_COPY = randomUUID(); // touch → relates_to → copy-kind company
const COPY_TO_COPY = randomUUID(); // copy-kind touch → copy-kind company
const COPY_ACME = randomUUID(); // a company of the copied kind

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));

  for (const [id, slug] of [
    [ids.touchKind, "outreach-touch"],
    [ids.person, "person"],
    [ids.company, "company"],
    [ids.note, "note"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, scope, user_id, is_active) values ($1,$2,$2,'system',$3,true)`,
      [id, slug, USER]
    );
  }
  for (const [id, slug] of [
    [ids.touchCopy, "outreach-touch"],
    [ids.companyCopy, "company"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, scope, user_id, is_active, workspace_id) values ($1,$2,$2,'workspace',$3,true,$4)`,
      [id, slug, USER, COPY_WS]
    );
  }
  await q(
    `insert into relation_defs (id, slug, display_name, user_id) values ($1,'relates_to','Relates to',$3),($2,'sent_to','Sent to',$3)`,
    [ids.relatesTo, ids.sentTo, USER]
  );
  const required = JSON.stringify({ required: true, requiredBy: "crm" });
  await q(
    `insert into profile_relations (source_profile_id, target_profile_id, relation_def_id, metadata) values
       ($1,$2,$4,$6::jsonb),($1,$3,$4,$6::jsonb),($1,$2,$5,'{}'::jsonb),
       ($7,$2,$4,$6::jsonb),($7,$8,$4,$6::jsonb)`,
    [
      ids.touchKind,
      ids.person,
      ids.company,
      ids.relatesTo,
      ids.sentTo,
      required,
      ids.touchCopy,
      ids.companyCopy,
    ]
  );
  // The touch's entity_id properties: `contact` syncs to relates_to → person,
  // `memo` syncs to relates_to → note, `recipient` to sent_to (not required).
  for (const [slug, relationDefId, target] of [
    ["contact", ids.relatesTo, ids.person],
    ["memo", ids.relatesTo, ids.note],
    ["recipient", ids.sentTo, ids.person],
  ] as const) {
    await q(
      `insert into property_defs (id, slug, profile_id, value_type, relation_def_id, target_profile_id)
       values (gen_random_uuid(),$1,$2,'entity_id',$3,$4)`,
      [slug, ids.touchKind, relationDefId, target]
    );
  }

  const entity = (
    id: string,
    profileId: string,
    title: string,
    workspaceId: string | null,
    deleted = false
  ) =>
    q(
      `insert into entities (id, user_id, type, profile_id, title, properties, workspace_id, deleted_at)
       values ($1,$2,'x',$3,$4,'{}'::jsonb,$5,${deleted ? "now()" : "null"})`,
      [id, USER, profileId, title, workspaceId]
    );
  await entity(ADA, ids.person, "Ada", null);
  await entity(ACME, ids.company, "Acme", null);
  await entity(MEMO, ids.note, "Memo", WS);
  await entity(LINKED, ids.touchKind, "Hello Ada", WS);
  await entity(WRONG_KIND, ids.touchKind, "Hello memo", WS);
  await entity(BARE, ids.touchKind, "Hello nobody", WS);
  await entity(DELETED, ids.touchKind, "Gone", WS, true);
  await entity(ELSEWHERE, ids.touchKind, "Elsewhere", OTHER_WS);
  await entity(COPY_ACME, ids.companyCopy, "Copy Acme", COPY_WS);
  await entity(COPY_BARE, ids.touchCopy, "Copy, nobody", COPY_WS);
  await entity(TO_COPY, ids.touchKind, "Hello copy Acme", COPY_WS);
  await entity(COPY_TO_COPY, ids.touchCopy, "Copy, hello copy Acme", COPY_WS);
  const edge = (source: string, target: string, type: string) =>
    q(
      `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values (gen_random_uuid(),$1,$2,$3,$4)`,
      [USER, source, target, type]
    );
  await edge(LINKED, ADA, "relates_to");
  await edge(WRONG_KIND, MEMO, "relates_to");
  await edge(TO_COPY, COPY_ACME, "relates_to");
  await edge(COPY_TO_COPY, COPY_ACME, "relates_to");
}, 120_000);

const RELATES_TO_LEAD = {
  kind: "outreach-touch",
  type: "relates_to",
  targetKinds: ["company", "person"],
  requiredBy: "crm",
};

describe("checkRequiredLinksForCreate — what a new record leaves out", () => {
  it("a new touch misses its required relates_to, once, naming both target kinds", async () => {
    const check = await checkRequiredLinksForCreate({
      kind: "outreach-touch",
    });
    expect(check).toEqual({ status: "missing", missing: [RELATES_TO_LEAD] });
    expect(missingLinkWarning(check.missing[0]!)).toBe(
      "outreach-touch has no relates_to to company or person: required by template crm. Add the link (synap_link_entities) once the record exists."
    );
  });

  it("a kind with no required link is clear (sent_to is declared, not required)", async () => {
    expect(await checkRequiredLinksForCreate({ kind: "note" })).toEqual({
      status: "clear",
      missing: [],
    });
  });

  it("an entity_id property the door syncs to the required relation is the link", async () => {
    const properties = (values: Record<string, unknown>) => ({
      kind: "outreach-touch",
      properties: { profileId: ids.touchKind, values },
    });
    expect(
      await checkRequiredLinksForCreate(properties({ contact: ADA }))
    ).toEqual({ status: "clear", missing: [] });
    // A synced edge of the type to a kind the rule does not name is no link,
    // and neither is a property left unset or one of another type.
    for (const values of [
      { memo: MEMO },
      { contact: "" },
      { recipient: ADA },
    ]) {
      expect(await checkRequiredLinksForCreate(properties(values))).toEqual({
        status: "missing",
        missing: [RELATES_TO_LEAD],
      });
    }
  });

  it("a failed read is unchecked, never clear", async () => {
    const broken = {
      select: () => {
        throw new Error("db down");
      },
    };
    expect(
      await checkRequiredLinksForCreate({
        kind: "outreach-touch",
        database: broken as never,
      })
    ).toEqual({ status: "unchecked", missing: [] });
  });
});

describe("checkRequiredLinksForGraph — an edge in the same call counts", () => {
  const touch = {
    op: "create_entity" as const,
    ref: "t1",
    profileSlug: "outreach-touch",
    title: "Hello Ada",
  };

  it("a touch whose relates_to to a person rides the same graph does not warn", async () => {
    const check = await checkRequiredLinksForGraph([
      touch,
      { op: "create_entity", ref: "p1", profileSlug: "person", title: "Ada" },
      {
        op: "create_relation",
        sourceRef: "t1",
        targetRef: "p1",
        type: "relates_to",
      },
    ]);
    expect(check).toEqual({ status: "clear", missing: [] });
  });

  it("an edge to an existing id counts (its kind is not read); one to a note op does not", async () => {
    expect(
      await checkRequiredLinksForGraph([
        touch,
        {
          op: "create_relation",
          sourceRef: "$primary",
          targetRef: ACME,
          type: "relates_to",
        },
      ])
    ).toEqual({ status: "clear", missing: [] });

    expect(
      await checkRequiredLinksForGraph([
        touch,
        { op: "create_entity", ref: "n1", profileSlug: "note", title: "Memo" },
        {
          op: "create_relation",
          sourceRef: "t1",
          targetRef: "n1",
          type: "relates_to",
        },
      ])
    ).toEqual({
      status: "missing",
      missing: [{ ...RELATES_TO_LEAD, forRef: "t1", forTitle: "Hello Ada" }],
    });
  });

  it("a touch that LINKS an existing record is not a new record: nothing to warn", async () => {
    expect(
      await checkRequiredLinksForGraph([{ ...touch, existingEntityId: BARE }])
    ).toEqual({ status: "clear", missing: [] });
  });
});

describe("undeclaredLinkWarning — the relation door (D3.3)", () => {
  it("sent_to from a touch to a company warns: the touch declares sent_to to person only", async () => {
    expect(
      await undeclaredLinkWarning({
        type: "sent_to",
        sourceEntityId: BARE,
        targetEntityId: ACME,
      })
    ).toBe(
      "No template declares a sent_to link from outreach-touch to company (outreach-touch declares sent_to to person). The link was written; check it is the one you meant."
    );
  });

  it("a declared pair is quiet, and so is a kind that declares no link of the type", async () => {
    expect(
      await undeclaredLinkWarning({
        type: "sent_to",
        sourceEntityId: BARE,
        targetEntityId: ADA,
      })
    ).toBeNull();
    expect(
      await undeclaredLinkWarning({
        type: "relates_to",
        sourceEntityId: MEMO,
        targetEntityId: ADA,
      })
    ).toBeNull();
  });
});

describe("requiredLinkDebtByWorkspace — template health's list", () => {
  it("per space: the live touches with no relates_to to a person or company", async () => {
    const debt = await requiredLinkDebtByWorkspace([WS, OTHER_WS]);
    const here = debt.get(WS)!;
    expect(here).toHaveLength(1);
    expect(here[0]).toMatchObject({ ...RELATES_TO_LEAD, count: 2 });
    expect([...here[0]!.entityIds].sort()).toEqual([BARE, WRONG_KIND].sort());
    expect(debt.get(OTHER_WS)).toEqual([
      expect.objectContaining({ count: 1, entityIds: [ELSEWHERE] }),
    ]);
  });

  it("a space outside the lens it is handed is never read", async () => {
    const debt = await requiredLinkDebtByWorkspace([OTHER_WS]);
    expect(debt.has(WS)).toBe(false);
  });

  it("both ends match by kind slug: workspace copies count as the kind, once", async () => {
    const debt = await requiredLinkDebtByWorkspace([COPY_WS]);
    // COPY_BARE is a touch (a copy of the kind) with no edge; TO_COPY and
    // COPY_TO_COPY reach a company (a copy of the kind). One line, not one per
    // copy of the rule.
    expect(debt.get(COPY_WS)).toEqual([
      { ...RELATES_TO_LEAD, count: 1, entityIds: [COPY_BARE] },
    ]);
  });

  it("the sample is capped", async () => {
    const debt = await requiredLinkDebtByWorkspace([WS], undefined, 1);
    expect(debt.get(WS)![0]).toMatchObject({ count: 2 });
    expect(debt.get(WS)![0]!.entityIds).toHaveLength(1);
  });
});
