/**
 * A key pinned to a PROJECT never writes a role beyond its project (app
 * permissions W3a, decision 51ad8d1e F3: a project place covers no whole
 * space). Through the REAL `roleRowInKeyReach` and `roleWriteGrantSpace`,
 * with the real write check (`grantWriteDenial`) and the real read clause
 * (`keyGrantReadClause`), on PGlite with every @synap/database table.
 *
 * Rows rule out:
 *   - `roleRowInKeyReach` reading a scope pinned to projects (no space) as
 *     "not limited to spaces": it found EVERY role row, in every space, for
 *     a key whose read clause reads no role row at all (`entity_facets` has
 *     no project path);
 *   - `permittedUnlimited` reading the same scope as unlimited: a role write
 *     passed on the permit alone, skipping the reach clause every other
 *     narrowed scope takes (the record readable by the key, in the role's
 *     space reach);
 *   - a role write on a record outside the key's project passing at all;
 *   - a SHARED role (stored pod-wide) changed by a project pin on its permit
 *     alone, on a record the key cannot read;
 *   - an empty project list or the deny-all grant read as unpinned.
 *
 * Cannot see: production Postgres constraints (tables from the Drizzle
 * definitions without FKs / enums); the HTTP doors (their own suites,
 * entities.app-role-write and status-move-grant).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
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

import { type KeyGrant } from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { allSchemaTables, pgliteSchemaDdl } from "../__tests__/pglite-ddl.js";
import { roleRowInKeyReach, roleWriteGrantSpace } from "./role-write-grant.js";

const ALICE = randomUUID();
const CRM = randomUUID(); // the space the role is stamped in
const P = randomUUID(); // the key's project
const PERSON_KIND = randomUUID();
const ROLE_CONTACT = randomUUID(); // a role homed in CRM
const IN = randomUUID(); // a pod-wide person filed in P, a contact in CRM
const OUT = randomUUID(); // a pod-wide person in no project, a contact in CRM
const F_IN = randomUUID();
const F_OUT = randomUUID();
const ROLE_DEAL = randomUUID(); // a SHARED role granted to CRM (rows stored pod-wide)
const S_IN = randomUUID(); // IN's deal (shared, stored NULL)
const S_OUT = randomUUID(); // OUT's deal (shared, stored NULL)

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const grant = (...scopes: GrantScope[]): KeyGrant => ({
  scopes,
  clientId: null,
});

beforeAll(async () => {
  await h.client!.exec(pgliteSchemaDdl(allSchemaTables()));
  await q(
    `insert into users (id, email, user_type) values ($1,'a@x','human')`,
    [ALICE]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'CRM',$2,'{}'::jsonb)`,
    [CRM, ALICE]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), CRM, ALICE]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name) values ($1,$2,$3,'P')`,
    [P, ALICE, CRM]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'person','Person','kind','system','pod',true,'{}'::jsonb,null),
       ($2,'contact','Contact','role','workspace','workspace',true,'{}'::jsonb,$3)`,
    [PERSON_KIND, ROLE_CONTACT, CRM]
  );
  for (const id of [IN, OUT]) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,null,$3,'person','p','{}'::jsonb,'{}'::jsonb)`,
      [id, ALICE, PERSON_KIND]
    );
  }
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, source_kind, target_kind)
     values ($1,$2,$3,$4,$5,'belongs_to_project','entity','entity')`,
    [randomUUID(), ALICE, CRM, IN, P]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'deal','Deal','role','shared','pod',true,'{}'::jsonb,null)`,
    [ROLE_DEAL]
  );
  await q(
    `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2)`,
    [ROLE_DEAL, CRM]
  );
  for (const [id, entityId] of [
    [S_IN, IN],
    [S_OUT, OUT],
  ] as const) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, properties)
       values ($1,$2,$3,$4,null,null,'{}'::jsonb)`,
      [id, entityId, ROLE_DEAL, ALICE]
    );
  }
  for (const [id, entityId] of [
    [F_IN, IN],
    [F_OUT, OUT],
  ] as const) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, properties)
       values ($1,$2,$3,$4,$5,null,'{}'::jsonb)`,
      [id, entityId, ROLE_CONTACT, ALICE, CRM]
    );
  }
}, 120_000);

/** A role's stage move (`moveStatus`'s role write) on `entityId`'s contact. */
const moveRole = (entityId: string, facetId: string, g: KeyGrant) =>
  roleWriteGrantSpace(
    "update",
    { entityId, facetId, profileId: null, storedWorkspaceId: CRM },
    { subjectType: "entity", action: "transition", data: { id: entityId } },
    g
  );

/** The same move on `entityId`'s SHARED deal role (row stored pod-wide). */
const moveShared = (entityId: string, facetId: string, g: KeyGrant) =>
  roleWriteGrantSpace(
    "update",
    { entityId, facetId, profileId: null, storedWorkspaceId: null },
    { subjectType: "entity", action: "transition", data: { id: entityId } },
    g
  );

describe("roleRowInKeyReach — a project pin finds no role row", () => {
  const pinned = grant({ permissions: ["*"], projectIds: [P] });

  it("a key pinned to a project, with no space: no role row, in or out of its project", async () => {
    expect(await roleRowInKeyReach(F_OUT, pinned)).toBe(false);
    expect(await roleRowInKeyReach(F_IN, pinned)).toBe(false);
  });

  it("a key pinned to objects, with no space: none either", async () => {
    expect(
      await roleRowInKeyReach(
        F_IN,
        grant({ permissions: ["*"], entityIds: [IN] })
      )
    ).toBe(false);
  });

  it("an empty project list, or the deny-all grant: no role row", async () => {
    expect(
      await roleRowInKeyReach(
        F_IN,
        grant({ permissions: ["*"], projectIds: [] })
      )
    ).toBe(false);
    expect(await roleRowInKeyReach(F_IN, grant({ permissions: [] }))).toBe(
      false
    );
  });

  it("control: a project pin beside an UNPINNED scope finds every row (the unpinned scope does)", async () => {
    expect(
      await roleRowInKeyReach(
        F_OUT,
        grant({ permissions: ["*"], projectIds: [P] }, { permissions: ["*"] })
      )
    ).toBe(true);
  });

  it("control: an unpinned key finds every row; a key on CRM finds CRM's", async () => {
    expect(await roleRowInKeyReach(F_OUT, grant({ permissions: ["*"] }))).toBe(
      true
    );
    expect(
      await roleRowInKeyReach(
        F_OUT,
        grant({ permissions: ["*"], workspaceIds: [CRM] })
      )
    ).toBe(true);
  });
});

describe("roleWriteGrantSpace — a project pin is not unlimited", () => {
  const READ_UPDATE = ["entity.person.read", "entity.person.update"];

  it("a record outside the key's project: refused", async () => {
    const res = await moveRole(
      OUT,
      F_OUT,
      grant({ permissions: READ_UPDATE, projectIds: [P] })
    );
    expect(res).toHaveProperty("denied");
  });

  it("a record in the project the key does not READ: refused by the reach clause, as for a space pin", async () => {
    const res = await moveRole(
      IN,
      F_IN,
      grant({ permissions: ["entity.person.update"], projectIds: [P] })
    );
    expect(res).toHaveProperty("denied");
    // The same permit pinned to CRM is refused the same way.
    expect(
      await moveRole(
        IN,
        F_IN,
        grant({ permissions: ["entity.person.update"], workspaceIds: [CRM] })
      )
    ).toHaveProperty("denied");
  });

  it("control: a record in the project the key reads moves in the role's space", async () => {
    expect(
      await moveRole(
        IN,
        F_IN,
        grant({ permissions: READ_UPDATE, projectIds: [P] })
      )
    ).toEqual({ space: CRM });
  });

  it("a SHARED role on a record in the project the key does not READ: refused (no space holds the row; the read is its one reach)", async () => {
    expect(
      await moveShared(
        IN,
        S_IN,
        grant({ permissions: ["entity.person.update"], projectIds: [P] })
      )
    ).toHaveProperty("denied");
  });

  it("a SHARED role on a record outside the key's project: refused", async () => {
    expect(
      await moveShared(
        OUT,
        S_OUT,
        grant({ permissions: READ_UPDATE, projectIds: [P] })
      )
    ).toHaveProperty("denied");
  });

  it("control: a SHARED role on a record in the project the key reads moves pod scope", async () => {
    expect(
      await moveShared(
        IN,
        S_IN,
        grant({ permissions: READ_UPDATE, projectIds: [P] })
      )
    ).toEqual({ space: null });
  });

  it("control: an unpinned key passes on its permit alone, stamped or shared", async () => {
    expect(
      await moveShared(OUT, S_OUT, grant({ permissions: ["entity.person.update"] }))
    ).toEqual({ space: null });
  });

  it("control: an unpinned key passes on its permit alone", async () => {
    expect(
      await moveRole(
        OUT,
        F_OUT,
        grant({ permissions: ["entity.person.update"] })
      )
    ).toEqual({ space: CRM });
  });
});
