/**
 * PROJECT REACH in the grant engine (app-permission plan 8189ae7c, W1).
 *
 * A scope pinned to projects P reads the rows IN P, table by table, through
 * the real clause (`grantReadClause`) on PGlite with every @synap/database
 * table; and the write gate never lets a project pin decide what P holds
 * (the filing rule), through the real `grantWriteDenial` and the real filing
 * door (`fileEntitiesGoverned`).
 *
 * Rows rule out:
 *   - a table that still fails closed for a project pin (before W1 every
 *     table but `entities` read nothing);
 *   - a project path that leaks another project's rows (Q) or rows in no
 *     project (N);
 *   - an edge read with only ONE end in the project (it names a record the
 *     project does not hold);
 *   - a write placed where the CALLER says the row is (`projectId` sent)
 *     instead of where it lives now;
 *   - a project pin covering a filing: an app holding a write in P files into
 *     P a record it can only read, then writes it through P.
 *
 * Cannot see: production Postgres constraints (tables from the Drizzle
 * definitions without FKs / enums).
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

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import {
  channels,
  documents,
  entities,
  focusSessions,
  projects,
  projectTracks,
  proposals,
  relations,
  trackParticipants,
  views,
} from "@synap/database/schema";
import { grantOfScope, runWithGrant, type KeyGrant } from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { grantReadClause } from "./grant-read.js";
import {
  grantWriteDenial,
  type GrantWriteInput,
} from "../utils/grant-write-check.js";
import {
  assertGrantMayFile,
  existingEntitiesGrantMayFile,
  fileEntitiesGoverned,
} from "../services/projects/file-entities.js";

const ALICE = randomUUID();
const W = randomUUID();
const P = randomUUID();
const Q = randomUUID();

const E = { p: randomUUID(), p2: randomUUID(), q: randomUUID(), n: randomUUID() };
const DOC = { p: randomUUID(), n: randomUUID() };
const REL = {
  bpP: randomUUID(), // E.p  --belongs_to_project--> P
  bpP2: randomUUID(), // E.p2 --belongs_to_project--> P
  bpQ: randomUUID(), // E.q  --belongs_to_project--> Q
  inside: randomUUID(), // E.p --related_to--> E.p2 (both in P)
  outside: randomUUID(), // E.p --related_to--> E.n (one end out)
};
const SESS = { p: randomUUID(), q: randomUUID(), n: randomUUID() };
const CH = {
  room: randomUUID(), // the room of SESS.p
  pinned: randomUUID(), // channels.project_id = P
  ofEntity: randomUUID(), // the channel of E.p
  none: randomUUID(),
};
const PROP = { p: randomUUID(), q: randomUUID(), n: randomUUID() };
const VIEW = { p: randomUUID(), q: randomUUID(), n: randomUUID() };
const TRACK = { p: randomUUID(), q: randomUUID() };
const PART = { p: randomUUID(), q: randomUUID() };

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(`insert into users (id, email, user_type) values ($1,'a@x','human')`, [
    ALICE,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
    [W, ALICE]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), W, ALICE]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name) values ($1,$3,$4,'P'),($2,$3,$4,'Q')`,
    [P, Q, ALICE, W]
  );
  await q(
    `insert into entities (id, type, user_id, workspace_id, document_id) values
       ($1,'task',$5,$6,$7), ($2,'task',$5,null,null), ($3,'task',$5,$6,null), ($4,'task',$5,$6,$8)`,
    [E.p, E.p2, E.q, E.n, ALICE, W, DOC.p, DOC.n]
  );
  await q(
    `insert into documents (id, title, user_id, workspace_id) values ($1,'p',$3,$4),($2,'n',$3,$4)`,
    [DOC.p, DOC.n, ALICE, W]
  );
  const rel = (id: string, s: string, t: string, type: string) =>
    q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, source_kind, target_kind)
       values ($1,$2,$3,$4,$5,$6,'entity','entity')`,
      [id, ALICE, W, s, t, type]
    );
  await rel(REL.bpP, E.p, P, "belongs_to_project");
  await rel(REL.bpP2, E.p2, P, "belongs_to_project");
  await rel(REL.bpQ, E.q, Q, "belongs_to_project");
  await rel(REL.inside, E.p, E.p2, "related_to");
  await rel(REL.outside, E.p, E.n, "related_to");
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, channel_id, goal, status) values
       ($1,$4,null,$5,$7,'g','active'), ($2,$4,null,$6,null,'g','active'), ($3,$4,$8,null,null,'g','active')`,
    [SESS.p, SESS.q, SESS.n, ALICE, P, Q, CH.room, W]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, project_id, channel_type, status, context_object_type, context_object_id) values
       ($1,$5,null,null,'ai_thread','active','focus_session',$6),
       ($2,$5,null,$7,'ai_thread','active',null,null),
       ($3,$5,$8,null,'ai_thread','active','entity',$9),
       ($4,$5,$8,null,'ai_thread','active',null,null)`,
    [CH.room, CH.pinned, CH.ofEntity, CH.none, ALICE, SESS.p, P, W, E.p]
  );
  await q(
    `insert into proposals (id, created_by, status, workspace_id, project_id) values
       ($1,$4,'pending',$5,$6),($2,$4,'pending',$5,$7),($3,$4,'pending',$5,null)`,
    [PROP.p, PROP.q, PROP.n, ALICE, W, P, Q]
  );
  await q(
    `insert into views (id, name, type, user_id, workspace_id, project_id) values
       ($1,'v','table',$4,$5,$6),($2,'v','table',$4,$5,$7),($3,'v','table',$4,$5,null)`,
    [VIEW.p, VIEW.q, VIEW.n, ALICE, W, P, Q]
  );
  await q(
    `insert into project_tracks (id, user_id, project_id, name) values
       ($1,$3,$4,'tp'),($2,$3,$5,'tq')`,
    [TRACK.p, TRACK.q, ALICE, P, Q]
  );
  await q(
    `insert into track_participants (id, track_id, principal_kind, principal_id, role)
     values ($1,$3,'user',$5,'owner'),($2,$4,'user',$5,'owner')`,
    [PART.p, PART.q, TRACK.p, TRACK.q, ALICE]
  );
});

type Sel = {
  select: (c: object) => {
    from: (t: object) => { where: (w: unknown) => Promise<{ id: string }[]> };
  };
};
/** The ids of `table` the clause of `scope` lets through (no floor). */
const reads = async (
  table: object,
  idCol: unknown,
  scope: GrantScope
): Promise<string[]> => {
  const rows = await (h.db as Sel)
    .select({ id: idCol as never })
    .from(table)
    .where(grantReadClause(table, scope));
  return rows.map((r) => r.id).sort();
};
const sorted = (...ids: string[]) => [...ids].sort();
const inP = (permission: string): GrantScope => ({
  permissions: [permission],
  projectIds: [P],
});

describe("a scope pinned to project P reads the rows IN P (W1)", () => {
  const cases: Array<[string, object, unknown, string, string[]]> = [
    ["entities", entities, entities.id, "entity.read", [E.p, E.p2]],
    ["documents (a body follows its entity)", documents, documents.id, "document.read", [DOC.p]],
    [
      "relations (both ends in P; the filing edge to P itself)",
      relations,
      relations.id,
      "relation.read",
      [REL.bpP, REL.bpP2, REL.inside],
    ],
    ["focus_sessions", focusSessions, focusSessions.id, "session.read", [SESS.p]],
    [
      "channels (pinned to P, or the room of a session in P)",
      channels,
      channels.id,
      "channel.read",
      [CH.room, CH.pinned],
    ],
    ["proposals", proposals, proposals.id, "proposal.read", [PROP.p]],
    ["views", views, views.id, "view.read", [VIEW.p]],
    ["project_tracks", projectTracks, projectTracks.id, "track.read", [TRACK.p]],
    [
      "track_participants (who is on a goal of P)",
      trackParticipants,
      trackParticipants.id,
      "track.read",
      [PART.p],
    ],
    ["projects (the project row itself)", projects, projects.id, "project.read", [P]],
  ];

  it.each(cases)("%s", async (_name, table, idCol, permission, expected) => {
    expect(await reads(table, idCol, inP(permission))).toEqual(
      sorted(...expected)
    );
  });

  it("CONTROL — the same scope with no pin adds no clause (every row)", () => {
    for (const [, table, , permission] of cases)
      expect(grantReadClause(table, { permissions: [permission] })).toBeUndefined();
  });

  it("a pin on Q reads Q's rows, never P's", async () => {
    const inQ = (permission: string): GrantScope => ({
      permissions: [permission],
      projectIds: [Q],
    });
    expect(await reads(focusSessions, focusSessions.id, inQ("session.read"))).toEqual([SESS.q]);
    expect(await reads(proposals, proposals.id, inQ("proposal.read"))).toEqual([PROP.q]);
    expect(await reads(relations, relations.id, inQ("relation.read"))).toEqual([REL.bpQ]);
  });

  it("a channel of a record follows that record, when the scope also reads records", async () => {
    expect(
      await reads(channels, channels.id, {
        permissions: ["channel.read", "entity.read"],
        projectIds: [P],
      })
    ).toEqual(sorted(CH.room, CH.pinned, CH.ofEntity));
  });

  it("the subject still decides: a project pin reads no table its permissions do not name", async () => {
    expect(await reads(focusSessions, focusSessions.id, inP("entity.read"))).toEqual([]);
  });

  it("a space pin and a project pin together read the rows in BOTH", async () => {
    expect(
      await reads(proposals, proposals.id, {
        permissions: ["proposal.read"],
        workspaceIds: [W],
        projectIds: [P],
      })
    ).toEqual([PROP.p]);
  });

  it("a relational read (db.query) of sessions renders the project path", async () => {
    const rows = await (
      h.db as {
        query: {
          focusSessions: {
            findMany: (a: object) => Promise<Array<{ id: string }>>;
          };
        };
      }
    ).query.focusSessions.findMany({
      where: grantReadClause(focusSessions, inP("session.read")),
      columns: { id: true },
    });
    expect(rows.map((r) => r.id)).toEqual([SESS.p]);
  });
});

describe("the filing rule: a project pin never decides what a project holds", () => {
  const WRITE_IN_P: GrantScope = {
    permissions: [
      "entity.update",
      "entity.create",
      "session.update",
      "project.read",
      "project.file_entities",
      "link.delete",
    ],
    projectIds: [P],
  };
  const denial = (input: GrantWriteInput, scope: GrantScope = WRITE_IN_P) =>
    runWithGrant(grantOfScope(scope), () => grantWriteDenial(input));

  it("a record is written where it lives now, never where the caller says it is", async () => {
    // E.n is in no project: claiming P (the gate's projectId or data's) is no reach.
    expect(
      await denial({
        subjectType: "entity",
        action: "update",
        workspaceId: W,
        projectId: P,
        data: { id: E.n, projectId: P },
      })
    ).toMatch(/does not allow/);
    // E.p is filed in P: written through P with no project named.
    expect(
      await denial({
        subjectType: "entity",
        action: "update",
        workspaceId: W,
        data: { id: E.p },
      })
    ).toBeNull();
  });

  it("a NEW record lands in P (data.projectId is where a create lands)", async () => {
    expect(
      await denial({
        subjectType: "entity",
        action: "create",
        workspaceId: W,
        data: { profileSlug: "task", projectId: P },
      })
    ).toBeNull();
  });

  it("a session is written where it is filed now; filing one INTO P is refused", async () => {
    expect(
      await denial({
        subjectType: "focus_session",
        action: "update",
        workspaceId: null,
        data: { id: SESS.p },
      })
    ).toBeNull();
    // The filing gate's shape: data.projectId is the TARGET, not the place.
    expect(
      await denial({
        subjectType: "focus_session",
        action: "update",
        workspaceId: W,
        data: { id: SESS.n, projectId: P },
      })
    ).toMatch(/does not allow/);
    // Even out of P: a project pin never covers a filing.
    expect(
      await denial({
        subjectType: "focus_session",
        action: "update",
        workspaceId: null,
        data: { id: SESS.p, projectId: Q },
        filesIntoProject: true,
      })
    ).toMatch(/does not allow/);
  });

  it("CONTROL — the same filing acts pass a scope with no project pin", async () => {
    const unpinned: GrantScope = {
      permissions: ["project.file_entities", "link.delete"],
    };
    expect(
      await denial(
        {
          subjectType: "project",
          action: "file_entities",
          workspaceId: W,
          data: { id: P, projectId: P, entityIds: [E.n] },
        },
        unpinned
      )
    ).toBeNull();
    expect(
      await denial(
        {
          subjectType: "link",
          action: "delete",
          workspaceId: W,
          data: { id: P, linkType: "belongs_to_project", toId: P },
        },
        unpinned
      )
    ).toBeNull();
  });

  it("the belongs_to_project edge is never covered by a project pin (file or unfile)", async () => {
    expect(
      await denial({
        subjectType: "project",
        action: "file_entities",
        workspaceId: W,
        data: { id: P, projectId: P, entityIds: [E.n] },
      })
    ).toMatch(/does not allow/);
    expect(
      await denial({
        subjectType: "link",
        action: "delete",
        workspaceId: W,
        data: {
          id: P,
          projectId: P,
          linkType: "belongs_to_project",
          toId: P,
        },
      })
    ).toMatch(/does not allow/);
  });

  it("an app holding a write in P cannot file into P a record it can only READ", async () => {
    const app: KeyGrant = {
      scopes: [
        // It may read E.n where it is (space W) ...
        { permissions: ["entity.read"], workspaceIds: [W] },
        // ... and write in project P.
        WRITE_IN_P,
      ],
      clientId: "app-under-test",
    };
    const err = await runWithGrant(app, () =>
      fileEntitiesGoverned({ userId: ALICE, projectId: P, entityIds: [E.n] })
    ).then(
      () => null,
      (e: unknown) => e as { code?: string; message: string }
    );
    expect(err?.code).toBe("FORBIDDEN");
    expect(err?.message).toMatch(/nothing was filed: /);
    expect(err?.message).toContain(E.n);
    const { rows } = await q(
      `select id from relations where type = 'belongs_to_project' and source_entity_id = $1`,
      [E.n]
    );
    expect(rows).toEqual([]);
    // Nor through a capture that links it: an existing record it cannot write
    // where it is stays out of P.
    expect(
      await runWithGrant(app, () => existingEntitiesGrantMayFile([E.n]))
    ).toEqual([]);
  });

  it("CONTROL — a write on the record WHERE IT IS passes the key half", async () => {
    const inSpace: KeyGrant = {
      scopes: [{ permissions: ["entity.update"], workspaceIds: [W] }],
      clientId: "app-under-test",
    };
    await expect(
      runWithGrant(inSpace, () =>
        assertGrantMayFile({
          entities: [{ id: E.n, title: null, type: "task", workspaceId: W }],
        })
      )
    ).resolves.toBeUndefined();
    expect(
      await runWithGrant(inSpace, () => existingEntitiesGrantMayFile([E.n]))
    ).toEqual([E.n]);
    // No grant (a signed-in person): the key half checks nothing.
    expect(await existingEntitiesGrantMayFile([E.n, E.q])).toEqual([E.n, E.q]);
  });
});
