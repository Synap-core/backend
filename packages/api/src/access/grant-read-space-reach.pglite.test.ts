/**
 * SPACE REACH of a key grant (founder "option 1", 2026-10-23): an app granted
 * space S reads what a MEMBER of S reads there, read-only — including the
 * pod-wide people and companies (`workspace_id IS NULL`) that carry a live
 * role in S.
 *
 * Through the REAL `scopedDb(AccessContext).findMany` on PGlite with every
 * @synap/database table, inside `runWithGrant`, as the PERSON (an app key's
 * `effectiveUserId` is its owner — pod-app.invariants I3). The CONTROL (no
 * grant) shows the person's floor alone admits every row below, so each row a
 * granted read drops is the GRANT at work, not the floor.
 *
 * The two branches (grant-read.ts `spaceReach` → utils/project-scope.ts
 * `roleInSpacesWhere`):
 *   (a) a live facet stamped in a granted space (the member rule
 *       `facetLensMemberWhere`, space-keyed);
 *   (b) a pod-wide entity wearing a live pod-wide facet whose role is granted
 *       to a granted space (decision B `podSharedFacetWhere`, space-keyed).
 *
 * Rows rule out: the workspace match alone (no pod-wide row reached — the gap
 * this closes), a facet in ANY space counting, a detached facet counting, a
 * shared role counting wherever it is granted, the kind narrowing dropped, the
 * two-scope OR turned into an AND, the facet rows or the bodies left behind.
 *
 * Cannot see: production Postgres constraints (tables come from the Drizzle
 * definitions without FKs / NOT NULL / enums).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { documents, entities, entityFacets } from "@synap/database/schema";
import { grantOfScope, runWithGrant, type KeyGrant } from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { AccessContext, scopedDb } from "./index.js";

const PERSON = "reach-person"; // the app's owner: its reads run as this floor
const TEAMMATE = "reach-teammate";

const CRM = randomUUID();
const OTHER = randomUUID();

const PERSON_KIND = randomUUID();
const COMPANY_KIND = randomUUID();
const TASK_KIND = randomUUID();
const ROLE_LEAD = randomUUID(); // stamped per space (facet carries the space)
const ROLE_CLIENT = randomUUID(); // shared, granted to CRM → facet stored NULL
const ROLE_PARTNER = randomUUID(); // shared, granted to OTHER only

// Entities (pod-wide unless noted)
const P_CRM = randomUUID(); // person, LEAD facet in CRM            → (a)
const P_TEAM_CRM = randomUUID(); // teammate's person, facet in CRM  → (a)
const C_CLIENT = randomUUID(); // company, CLIENT facet (NULL)        → (b)
const T_OTHER_ROLED = randomUUID(); // OTHER-space task, facet in CRM → (a)
const T_CRM = randomUUID(); // a task stamped in CRM (the plain match)
const P_UNROLED = randomUUID(); // person, no facet
const P_OTHER = randomUUID(); // person, facet in OTHER only
const P_DETACHED = randomUUID(); // person, CRM facet detached
const P_PARTNER = randomUUID(); // person, PARTNER facet (granted OTHER)
const T_OTHER = randomUUID(); // a task stamped in OTHER, no role in CRM

const F_CRM = randomUUID();
const F_TEAM_CRM = randomUUID();
const F_CLIENT = randomUUID();
const F_OTHER_ROLED = randomUUID();
const F_OTHER = randomUUID();
const F_DETACHED = randomUUID();
const F_PARTNER = randomUUID();

const D_CRM = randomUUID(); // body of P_CRM
const D_CLIENT = randomUUID(); // body of C_CLIENT
const D_UNROLED = randomUUID(); // body of P_UNROLED
const D_PARTNER = randomUUID(); // body of P_PARTNER

const SEEN_BY_CRM = [P_CRM, P_TEAM_CRM, C_CLIENT, T_OTHER_ROLED, T_CRM];
const ALL = [
  ...SEEN_BY_CRM,
  P_UNROLED,
  P_OTHER,
  P_DETACHED,
  P_PARTNER,
  T_OTHER,
];

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
const sorted = (ids: string[]) => [...new Set(ids)].sort();

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [PERSON, TEAMMATE]) {
    await q(
      `insert into users (id, email, user_type) values ($1, $2, 'human')`,
      [u, `${u}@x.test`]
    );
  }
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), PERSON, randomUUID(), TEAMMATE]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'CRM',$3,'{}'::jsonb),($2,'Other',$3,'{}'::jsonb)`,
    [CRM, OTHER, PERSON]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       ($1,$2,$3,'owner'),($4,$5,$3,'owner'),($6,$2,$7,'editor')`,
    [randomUUID(), CRM, PERSON, randomUUID(), OTHER, randomUUID(), TEAMMATE]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, workspace_id) values
       ($1,'person','Person','kind','system',null),
       ($2,'company','Company','kind','system',null),
       ($3,'task','Task','kind','system',null),
       ($4,'lead','Lead','role','workspace',null),
       ($5,'client','Client','role','shared',null),
       ($6,'partner','Partner','role','shared',null)`,
    [PERSON_KIND, COMPANY_KIND, TASK_KIND, ROLE_LEAD, ROLE_CLIENT, ROLE_PARTNER]
  );
  await q(
    `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2),($3,$4)`,
    [ROLE_CLIENT, CRM, ROLE_PARTNER, OTHER]
  );

  const entity = (
    id: string,
    kind: "person" | "company" | "task",
    owner: string,
    ws: string | null,
    doc: string | null = null
  ) =>
    q(
      `insert into entities (id, type, profile_id, user_id, workspace_id, document_id, title) values ($1,$2,$3,$4,$5,$6,'e')`,
      [
        id,
        kind,
        { person: PERSON_KIND, company: COMPANY_KIND, task: TASK_KIND }[kind],
        owner,
        ws,
        doc,
      ]
    );
  await entity(P_CRM, "person", PERSON, null, D_CRM);
  await entity(P_TEAM_CRM, "person", TEAMMATE, null);
  await entity(C_CLIENT, "company", PERSON, null, D_CLIENT);
  await entity(T_OTHER_ROLED, "task", PERSON, OTHER);
  await entity(T_CRM, "task", PERSON, CRM);
  await entity(P_UNROLED, "person", PERSON, null, D_UNROLED);
  await entity(P_OTHER, "person", PERSON, null);
  await entity(P_DETACHED, "person", PERSON, null);
  await entity(P_PARTNER, "person", PERSON, null, D_PARTNER);
  await entity(T_OTHER, "task", PERSON, OTHER);

  const facet = (
    id: string,
    entityId: string,
    role: string,
    owner: string,
    ws: string | null,
    detached = false
  ) =>
    q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, deleted_at) values ($1,$2,$3,$4,$5,$6)`,
      [id, entityId, role, owner, ws, detached ? new Date() : null]
    );
  await facet(F_CRM, P_CRM, ROLE_LEAD, PERSON, CRM);
  await facet(F_TEAM_CRM, P_TEAM_CRM, ROLE_LEAD, TEAMMATE, CRM);
  await facet(F_CLIENT, C_CLIENT, ROLE_CLIENT, PERSON, null);
  await facet(F_OTHER_ROLED, T_OTHER_ROLED, ROLE_LEAD, PERSON, CRM);
  await facet(F_OTHER, P_OTHER, ROLE_LEAD, PERSON, OTHER);
  await facet(F_DETACHED, P_DETACHED, ROLE_LEAD, PERSON, CRM, true);
  await facet(F_PARTNER, P_PARTNER, ROLE_PARTNER, PERSON, null);

  for (const d of [D_CRM, D_CLIENT, D_UNROLED, D_PARTNER]) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,null,'Doc','markdown',1,1)`,
      [d, PERSON]
    );
  }
}, 120_000);

const read = async (table: object, grant?: GrantScope | KeyGrant) => {
  const run = () =>
    scopedDb(AccessContext.operator({ userId: PERSON })).findMany<{
      id: string;
    }>(table);
  const keyGrant =
    grant && "scopes" in grant ? grant : grant ? grantOfScope(grant) : null;
  const rows = keyGrant ? await runWithGrant(keyGrant, run) : await run();
  return sorted(rows.map((r) => r.id));
};

const CRM_READ: GrantScope = { permissions: ["entity.read"], workspaceIds: [CRM] };

describe("CONTROL — no grant: the person's floor admits every row", () => {
  it("entities, facets and bodies", async () => {
    expect(await read(entities)).toEqual(sorted(ALL));
    const facets = await read(entityFacets);
    for (const f of [F_CRM, F_TEAM_CRM, F_CLIENT, F_OTHER, F_PARTNER])
      expect(facets).toContain(f);
    expect(await read(documents)).toEqual(
      sorted([D_CRM, D_CLIENT, D_UNROLED, D_PARTNER])
    );
  });
});

describe("an app granted CRM sees what a member of CRM sees (entities)", () => {
  it("the stamped rows AND the pod-wide ones roled in CRM — nothing else", async () => {
    expect(await read(entities, CRM_READ)).toEqual(sorted(SEEN_BY_CRM));
  });

  it("(a) a pod-wide person with a live role stamped in CRM — the person's own and a teammate's", async () => {
    const seen = await read(entities, CRM_READ);
    expect(seen).toContain(P_CRM);
    expect(seen).toContain(P_TEAM_CRM);
  });

  it("(b) a pod-wide company wearing a shared role granted to CRM (facet stored NULL)", async () => {
    expect(await read(entities, CRM_READ)).toContain(C_CLIENT);
  });

  it("NOT: an un-roled pod-wide person, one roled only elsewhere, a detached role, a role granted only elsewhere, another space's row", async () => {
    const seen = await read(entities, CRM_READ);
    expect(seen).not.toContain(P_UNROLED);
    expect(seen).not.toContain(P_OTHER);
    expect(seen).not.toContain(P_DETACHED);
    expect(seen).not.toContain(P_PARTNER);
    expect(seen).not.toContain(T_OTHER);
  });

  it("a kind-qualified grant still narrows: companies only, no persons", async () => {
    expect(
      await read(entities, {
        permissions: ["entity.company.read"],
        workspaceIds: [CRM],
      })
    ).toEqual([C_CLIENT]);
    expect(
      await read(entities, {
        permissions: ["entity.person.read"],
        workspaceIds: [CRM],
      })
    ).toEqual(sorted([P_CRM, P_TEAM_CRM]));
  });

  it("two scopes still OR: persons reached in CRM ∪ tasks stamped in OTHER", async () => {
    const grant: KeyGrant = {
      clientId: null,
      scopes: [
        {
          permissions: ["entity.person.read"],
          workspaceIds: [CRM],
          projectIds: null,
          entityIds: null,
        },
        {
          permissions: ["entity.task.read"],
          workspaceIds: [OTHER],
          projectIds: null,
          entityIds: null,
        },
      ],
    };
    // OTHER reaches T_OTHER (stamped) and T_OTHER_ROLED (stamped there too);
    // OTHER's role reach adds P_OTHER / P_PARTNER, which are persons, so the
    // task-only scope drops them.
    expect(await read(entities, grant)).toEqual(
      sorted([P_CRM, P_TEAM_CRM, T_OTHER, T_OTHER_ROLED])
    );
  });

  it("an entity pin still narrows inside the reach", async () => {
    expect(
      await read(entities, {
        permissions: ["entity.read"],
        workspaceIds: [CRM],
        entityIds: [C_CLIENT, P_UNROLED],
      })
    ).toEqual([C_CLIENT]);
  });
});

describe("the role rows and the bodies follow (facets, documents)", () => {
  it("facets: those stamped in CRM plus the pod-wide ones whose role is granted to CRM", async () => {
    const facets = await read(entityFacets, {
      permissions: ["facet.read"],
      workspaceIds: [CRM],
    });
    expect(facets).toContain(F_CRM);
    expect(facets).toContain(F_TEAM_CRM);
    expect(facets).toContain(F_OTHER_ROLED);
    expect(facets).toContain(F_CLIENT);
    expect(facets).not.toContain(F_OTHER);
    expect(facets).not.toContain(F_PARTNER);
  });

  it("documents: the pod-wide body of an entity CRM reaches by a role, never another's", async () => {
    expect(
      await read(documents, {
        permissions: ["document.read"],
        workspaceIds: [CRM],
      })
    ).toEqual(sorted([D_CRM, D_CLIENT]));
  });
});
