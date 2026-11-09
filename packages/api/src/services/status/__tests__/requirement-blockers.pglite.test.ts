/**
 * REQUIREMENT BLOCKERS on real SQL (PGlite), status-first wave (research
 * bf4dc995 option B step 5): "blocked because X is missing", declared on a
 * lifecycle option (`requires`) and derived live by the collector's
 * `requirement` source — never a stored flag.
 *
 *   - a KIND: an invoice `sent` requires an amount; met and unmet; a `draft`
 *     requires nothing;
 *   - a ROLE: a lead in `outreach` requires a contact at a company (a
 *     `works_at` link IN, `forKinds: company`) and a person's LinkedIn
 *     profile (`forKinds: person`, an agent's to find); met and unmet; a
 *     contact the reader may not see (deleted) does not count, nor a demo
 *     contact (filed only into a sample project: the listing rule); the same
 *     person asked as its KIND (no facet) is held to nothing;
 *   - flow.of's path (`readThingBlockers`) and statusOf read the same blocker;
 *   - BATCHED: the reads for every card are the reads for one.
 *
 * Only the lifecycle resolver is stubbed (by profile).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const INVOICE_P = "00000000-0000-4000-8000-00000000000a";
const LEAD_P = "00000000-0000-4000-8000-00000000000b";

const INVOICE = {
  propertySlug: "status",
  propertyDefId: "lifecycle",
  declaredOnProfileId: INVOICE_P,
  unclassified: [],
  initialStatus: null,
  options: [
    { key: "draft", label: "Draft", category: "open" },
    {
      key: "sent",
      label: "Sent",
      category: "active",
      requires: [
        {
          kind: "property",
          blockerKey: "no_amount",
          label: "An amount",
          property: "amount",
        },
      ],
    },
    { key: "paid", label: "Paid", category: "done" },
  ],
};
const LEAD = {
  propertySlug: "leadStage",
  propertyDefId: "lead-lifecycle",
  declaredOnProfileId: LEAD_P,
  unclassified: [],
  initialStatus: null,
  options: [
    { key: "new", label: "New", category: "open" },
    {
      key: "outreach",
      label: "Outreach",
      category: "active",
      requires: [
        {
          kind: "link",
          blockerKey: "no_contact",
          label: "A contact at the company",
          relation: "works_at",
          direction: "in",
          clearedBy: { playbookId: "find-right-contact" },
          forKinds: ["company"],
        },
        {
          kind: "property",
          blockerKey: "no_linkedin",
          property: "linkedinUrl",
          owner: "agent",
          clearedBy: { capability: "linkedin.find_profile" },
          forKinds: ["person"],
        },
      ],
    },
    { key: "engaged", label: "Engaged", category: "active" },
    { key: "won", label: "Won", category: "done" },
  ],
};

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const byProfile = (id: string) =>
    id === INVOICE_P ? INVOICE : id === LEAD_P ? LEAD : null;
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(id: string) {
        return byProfile(id);
      }
      async getEffectiveLifecycles(ids: readonly string[]) {
        return new Map(ids.map((id) => [id, byProfile(id)]));
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@synap/database/schema";
import {
  allSchemaTables,
  pgliteTableDdl,
} from "../../../__tests__/pglite-ddl.js";
import { readThingBlockers } from "../thing-blockers.js";
import { readStatusOf } from "../status-read.js";
import { readRequirementSources } from "../requirement-sources.js";

const ME = "user-me";
const W = randomUUID();
const PERSON_P = randomUUID();
const COMPANY_P = randomUUID();
// Things.
const INV_UNPAID = randomUUID(); // sent, no amount → blocked
const INV_OK = randomUUID(); // sent, amount → not blocked
const INV_DRAFT = randomUUID(); // draft, no amount → requires nothing
const ACME = randomUUID(); // lead company, no contact → blocked
const GLOBEX = randomUUID(); // lead company, one contact → not blocked
const INITECH = randomUUID(); // lead company, only a deleted contact → blocked
const HOOLI = randomUUID(); // lead company, only a DEMO contact → blocked
const EMIL = randomUUID(); // works at Hooli, filed only into a sample project
const DEMO = randomUUID(); // a sample (demo) project
const ADA = randomUUID(); // lead person, no LinkedIn → blocked (agent)
const BOB = randomUUID(); // lead person, LinkedIn → not blocked
const CARL = randomUUID(); // works at Globex
const DORA = randomUUID(); // works at Initech, deleted
const facetOf = new Map<string, string>();

let client: PGlite;
let queries = 0;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

async function thing(
  id: string,
  profileId: string,
  title: string,
  status: string | null,
  properties: Record<string, unknown> = {},
  deleted = false
) {
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, title, status, properties, created_at, updated_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), now(), $8)`,
    [
      id,
      ME,
      W,
      profileId,
      title,
      status,
      JSON.stringify(properties),
      deleted ? new Date().toISOString() : null,
    ]
  );
}

async function lead(entityId: string, status: string) {
  const id = randomUUID();
  facetOf.set(entityId, id);
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, properties, metadata, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb, '{}'::jsonb, now(), now())`,
    [id, entityId, LEAD_P, ME, W, status, JSON.stringify({ leadStage: status })]
  );
}

async function worksAt(person: string, company: string) {
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, created_at)
     values ($1, $2, $3, $4, $5, 'works_at', now())`,
    [randomUUID(), ME, W, person, company]
  );
}

beforeAll(async () => {
  client = new PGlite();
  for (const t of allSchemaTables()) await client.exec(pgliteTableDdl(t));
  holder.db = drizzle(client, {
    schema,
    logger: { logQuery: () => void (queries += 1) },
  });
  await q(
    `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Sales', 'personal')`,
    [W, ME]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), W, ME]
  );
  for (const [id, slug, kind] of [
    [INVOICE_P, "invoice", "kind"],
    [LEAD_P, "lead", "role"],
    [PERSON_P, "person", "kind"],
    [COMPANY_P, "company", "kind"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, $2, $2, $3, 'workspace')`,
      [id, slug, kind]
    );
  }
  await thing(INV_UNPAID, INVOICE_P, "Invoice 1", "sent");
  await thing(INV_OK, INVOICE_P, "Invoice 2", "sent", { amount: 1200 });
  await thing(INV_DRAFT, INVOICE_P, "Invoice 3", "draft");
  for (const [id, name] of [
    [ACME, "Acme"],
    [GLOBEX, "Globex"],
    [INITECH, "Initech"],
    [HOOLI, "Hooli"],
  ] as const) {
    await thing(id, COMPANY_P, name, null);
    await lead(id, "outreach");
  }
  await thing(ADA, PERSON_P, "Ada", null, { linkedinUrl: "  " });
  await thing(BOB, PERSON_P, "Bob", null, {
    linkedinUrl: "https://www.linkedin.com/in/bob",
  });
  await lead(ADA, "outreach");
  await lead(BOB, "outreach");
  await thing(CARL, PERSON_P, "Carl", null);
  await thing(DORA, PERSON_P, "Dora", null, {}, true);
  await worksAt(CARL, GLOBEX);
  await worksAt(DORA, INITECH);
  await thing(EMIL, PERSON_P, "Emil", null);
  await worksAt(EMIL, HOOLI);
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, sample, settings, metadata)
     values ($1, $2, $3, 'Demo', 'active', true, '{}'::jsonb, '{}'::jsonb)`,
    [DEMO, ME, W]
  );
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, created_at)
     values ($1, $2, $3, $4, $5, 'belongs_to_project', now())`,
    [randomUUID(), ME, W, EMIL, DEMO]
  );
  // A link of another type never meets a `works_at` requirement.
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, created_at)
     values ($1, $2, $3, $4, $5, 'relates_to', now())`,
    [randomUUID(), ME, W, CARL, ACME]
  );
});

const kindAsk = (id: string, status: string) => ({
  id,
  status,
  lifecycle: INVOICE as never,
});
const roleAsk = (id: string) => ({
  id,
  facetId: facetOf.get(id)!,
  status: "outreach",
  lifecycle: LEAD as never,
});

describe("a kind: the step's required property", () => {
  it("blocks while the amount is missing, never once it is there or before the step", async () => {
    const out = await readThingBlockers({ userId: ME }, [
      kindAsk(INV_UNPAID, "sent"),
      kindAsk(INV_OK, "sent"),
      kindAsk(INV_DRAFT, "draft"),
    ]);
    expect(out.get(INV_UNPAID)).toEqual({
      blocked: true,
      count: 1,
      why: {
        reason: "input",
        waitKind: "answer",
        blockedReason: null,
        blockerKey: "no_amount",
      },
      ball: "me",
      unlocks: { to: "paid", label: "Paid" },
      clearedBy: null,
      ref: { kind: "thing", label: "An amount" },
    });
    expect(out.get(INV_OK)?.blocked).toBe(false);
    expect(out.get(INV_DRAFT)?.blocked).toBe(false);
  });

  it("statusOf reads the same blocker", async () => {
    const answers = await readStatusOf(ME, [INV_UNPAID, INV_OK]);
    const of = (id: string) =>
      answers.find((a) => a.id === id) as {
        blocker?: { blocked: boolean; why?: { blockerKey: string | null } };
      };
    expect(of(INV_UNPAID).blocker).toMatchObject({
      blocked: true,
      why: { blockerKey: "no_amount" },
    });
    expect(of(INV_OK).blocker).toMatchObject({ blocked: false });
  });
});

describe("a role: the lead's required contact and LinkedIn profile", () => {
  it("blocks by kind: a company with no contact (a deleted or demo one does not count), a person with no profile", async () => {
    const out = await readThingBlockers({ userId: ME }, [
      roleAsk(ACME),
      roleAsk(GLOBEX),
      roleAsk(INITECH),
      roleAsk(HOOLI),
      roleAsk(ADA),
      roleAsk(BOB),
    ]);
    expect(out.get(ACME)).toMatchObject({
      blocked: true,
      // Only the contact: the LinkedIn requirement is for people.
      count: 1,
      ball: "me",
      why: { blockerKey: "no_contact" },
      unlocks: { to: "engaged", label: "Engaged" },
      clearedBy: { playbookId: "find-right-contact" },
      ref: { kind: "thing", label: "A contact at the company" },
    });
    expect(out.get(GLOBEX)?.blocked).toBe(false);
    expect(out.get(INITECH)).toMatchObject({
      blocked: true,
      why: { blockerKey: "no_contact" },
    });
    // Emil is a live, readable contact, but demo data: he never counts.
    expect(out.get(HOOLI)).toMatchObject({
      blocked: true,
      why: { blockerKey: "no_contact" },
    });
    expect(out.get(ADA)).toMatchObject({
      blocked: true,
      count: 1,
      ball: "agent",
      why: { waitKind: "agent_work", blockerKey: "no_linkedin" },
      clearedBy: { capability: "linkedin.find_profile" },
      ref: { kind: "thing", label: "No LinkedIn" },
    });
    expect(out.get(BOB)?.blocked).toBe(false);
  });

  it("the same thing asked as its kind (no facet) is held to nothing", async () => {
    const out = await readRequirementSources(ME, [
      { entityId: ADA },
      { entityId: ACME },
      { entityId: ADA, facetId: facetOf.get(ADA)! },
    ]);
    expect(out.get(`${ADA}:`)).toBeUndefined();
    expect(out.get(`${ACME}:`)).toBeUndefined();
    expect(out.get(`${ADA}:${facetOf.get(ADA)}`)?.length).toBe(1);
  });

  it("another reader's facet id on a thing they cannot read yields nothing", async () => {
    const out = await readRequirementSources("user-stranger", [
      { entityId: ACME, facetId: facetOf.get(ACME)! },
    ]);
    expect(out.size).toBe(0);
  });
});

describe("batched: the reads for every card are the reads for one", () => {
  it("does not grow with the number of cards", async () => {
    const count = async (ids: string[]) => {
      queries = 0;
      await readRequirementSources(
        ME,
        ids.map((id) => ({ entityId: id, facetId: facetOf.get(id)! }))
      );
      return queries;
    };
    const one = await count([ACME]);
    const all = await count([ACME, GLOBEX, INITECH, HOOLI, ADA, BOB]);
    // Things + facets + one link count (one direction declared).
    expect(one).toBe(3);
    expect(all).toBe(one);
  });
});
