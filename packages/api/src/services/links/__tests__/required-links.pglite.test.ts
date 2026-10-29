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
 *    create with its links in the same call must not warn").
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
const ids = {
  touchKind: randomUUID(),
  person: randomUUID(),
  company: randomUUID(),
  note: randomUUID(),
  relatesTo: randomUUID(),
  sentTo: randomUUID(),
};
const ADA = randomUUID(); // a person
const ACME = randomUUID(); // a company
const MEMO = randomUUID(); // a note
const LINKED = randomUUID(); // touch → relates_to → person
const WRONG_KIND = randomUUID(); // touch → relates_to → note
const BARE = randomUUID(); // touch with no edge
const DELETED = randomUUID(); // deleted touch with no edge
const ELSEWHERE = randomUUID(); // touch in another space, no edge

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
  await q(
    `insert into relation_defs (id, slug, display_name, user_id) values ($1,'relates_to','Relates to',$3),($2,'sent_to','Sent to',$3)`,
    [ids.relatesTo, ids.sentTo, USER]
  );
  const required = JSON.stringify({ required: true, requiredBy: "crm" });
  await q(
    `insert into profile_relations (source_profile_id, target_profile_id, relation_def_id, metadata) values
       ($1,$2,$4,$6::jsonb),($1,$3,$4,$6::jsonb),($1,$2,$5,'{}'::jsonb)`,
    [
      ids.touchKind,
      ids.person,
      ids.company,
      ids.relatesTo,
      ids.sentTo,
      required,
    ]
  );

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
  const edge = (source: string, target: string, type: string) =>
    q(
      `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values (gen_random_uuid(),$1,$2,$3,$4)`,
      [USER, source, target, type]
    );
  await edge(LINKED, ADA, "relates_to");
  await edge(WRONG_KIND, MEMO, "relates_to");
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
      profileId: ids.touchKind,
    });
    expect(check).toEqual({ status: "missing", missing: [RELATES_TO_LEAD] });
    expect(missingLinkWarning(check.missing[0]!)).toBe(
      "outreach-touch has no relates_to to company or person: required by template crm. Add the link (synap_link_entities) once the record exists."
    );
  });

  it("a kind with no required link is clear (sent_to is declared, not required)", async () => {
    expect(await checkRequiredLinksForCreate({ profileId: ids.note })).toEqual({
      status: "clear",
      missing: [],
    });
  });

  it("a failed read is unchecked, never clear", async () => {
    const broken = {
      select: () => {
        throw new Error("db down");
      },
    };
    expect(
      await checkRequiredLinksForCreate({
        profileId: ids.touchKind,
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

  it("the sample is capped", async () => {
    const debt = await requiredLinkDebtByWorkspace([WS], undefined, 1);
    expect(debt.get(WS)![0]).toMatchObject({ count: 2 });
    expect(debt.get(WS)![0]!.entityIds).toHaveLength(1);
  });
});
