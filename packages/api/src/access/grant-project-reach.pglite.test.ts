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
import { withProposalTargetPlace } from "./proposal-target-place.js";
import { assertMayDecideProposalAt } from "../routers/proposals/review-authority.js";
import { startOrchestrator } from "../services/focus-sessions/start-orchestrator.js";
import { gateSessionFiling } from "../services/focus-sessions/session-filing-gate.js";

const ALICE = randomUUID();
const W = randomUUID();
const P = randomUUID();
const Q = randomUUID();

const E = {
  p: randomUUID(),
  p2: randomUUID(),
  q: randomUUID(),
  n: randomUUID(),
};
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
  room: randomUUID(), // the room of SESS.p — the ONE channel a P pin reads
  pinned: randomUUID(), // a GROUP room tagged channels.project_id = P
  ofEntity: randomUUID(), // the thread of E.p (filed in P)
  external: randomUUID(), // a person's external channel; the person is in P
  none: randomUUID(),
};
/** A person filed in P, whose external channel is CH.external. */
const PERSON = randomUUID();
/**
 * In P by TARGET, never by `project_id` (a provenance tag):
 *   p    — about E.p (in P), stamped Q;
 *   q    — about E.q (in Q), STAMPED P: the receipt the review found;
 *   n    — about E.n (no project), stamped P;
 *   sess — about SESS.p; trk — about TRACK.p; odd — an unknown target type.
 */
const PROP = {
  p: randomUUID(),
  q: randomUUID(),
  n: randomUUID(),
  sess: randomUUID(),
  trk: randomUUID(),
  odd: randomUUID(),
};
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
  await q(
    `insert into users (id, email, user_type) values ($1,'a@x','human')`,
    [ALICE]
  );
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
  await q(
    `insert into entities (id, type, user_id, workspace_id) values ($1,'person',$2,null)`,
    [PERSON, ALICE]
  );
  await rel(randomUUID(), PERSON, P, "belongs_to_project");
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
       ($4,$5,$8,null,'ai_thread','active',null,null),
       ($10,$5,null,$7,'external_dm','active','entity',$11)`,
    [
      CH.room,
      CH.pinned,
      CH.ofEntity,
      CH.none,
      ALICE,
      SESS.p,
      P,
      W,
      E.p,
      CH.external,
      PERSON,
    ]
  );
  const prop = (id: string, type: string, target: string, stamp: string | null) =>
    q(
      `insert into proposals (id, created_by, status, workspace_id, project_id, target_type, target_id, proposal_type, data)
       values ($1,$2,'pending',$3,$4,$5,$6,'update','{}'::jsonb)`,
      [id, ALICE, W, stamp, type, target]
    );
  await prop(PROP.p, "entity", E.p, Q);
  await prop(PROP.q, "entity", E.q, P);
  await prop(PROP.n, "entity", E.n, P);
  await prop(PROP.sess, "focus_session", SESS.p, null);
  await prop(PROP.trk, "track", TRACK.p, null);
  await prop(PROP.odd, "probe", P, P);
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
    [
      "documents (a body follows its entity)",
      documents,
      documents.id,
      "document.read",
      [DOC.p],
    ],
    [
      "relations (both ends in P; the filing edge to P itself)",
      relations,
      relations.id,
      "relation.read",
      [REL.bpP, REL.bpP2, REL.inside],
    ],
    [
      "focus_sessions",
      focusSessions,
      focusSessions.id,
      "session.read",
      [SESS.p],
    ],
    [
      "channels (ONLY the room of a session in P)",
      channels,
      channels.id,
      "channel.read",
      [CH.room],
    ],
    [
      "proposals (by TARGET, never by their project_id stamp)",
      proposals,
      proposals.id,
      "proposal.read",
      [PROP.p, PROP.sess, PROP.trk],
    ],
    ["views", views, views.id, "view.read", [VIEW.p]],
    [
      "project_tracks",
      projectTracks,
      projectTracks.id,
      "track.read",
      [TRACK.p],
    ],
    [
      "track_participants (who is on a goal of P)",
      trackParticipants,
      trackParticipants.id,
      "track.read",
      [PART.p],
    ],
    [
      "projects (the project row itself)",
      projects,
      projects.id,
      "project.read",
      [P],
    ],
  ];

  it.each(cases)("%s", async (_name, table, idCol, permission, expected) => {
    expect(await reads(table, idCol, inP(permission))).toEqual(
      sorted(...expected)
    );
  });

  it("CONTROL — the same scope with no pin adds no clause (every row)", () => {
    for (const [, table, , permission] of cases)
      expect(
        grantReadClause(table, { permissions: [permission] })
      ).toBeUndefined();
  });

  it("a pin on Q reads Q's rows, never P's", async () => {
    const inQ = (permission: string): GrantScope => ({
      permissions: [permission],
      projectIds: [Q],
    });
    expect(
      await reads(focusSessions, focusSessions.id, inQ("session.read"))
    ).toEqual([SESS.q]);
    expect(await reads(proposals, proposals.id, inQ("proposal.read"))).toEqual([
      PROP.q,
    ]);
    expect(await reads(relations, relations.id, inQ("relation.read"))).toEqual([
      REL.bpQ,
    ]);
  });

  it("DELIBERATE DEFAULT: a group room tagged P, a P record's thread and the external channel of a person in P are NOT read — only the room", async () => {
    const read = await reads(channels, channels.id, {
      permissions: ["channel.read", "entity.read"],
      projectIds: [P],
    });
    expect(read).toEqual([CH.room]);
    for (const out of [CH.pinned, CH.ofEntity, CH.external])
      expect(read).not.toContain(out);
  });

  it("a proposal STAMPED P about a record outside P is not read; an unknown target type fails closed", async () => {
    const read = await reads(proposals, proposals.id, inP("proposal.read"));
    expect(read).not.toContain(PROP.q);
    expect(read).not.toContain(PROP.n);
    expect(read).not.toContain(PROP.odd);
  });

  it("the subject still decides: a project pin reads no table its permissions do not name", async () => {
    expect(
      await reads(focusSessions, focusSessions.id, inP("entity.read"))
    ).toEqual([]);
  });

  it("a space pin and a project pin in ONE scope read their INTERSECTION (in W and in P)", async () => {
    expect(
      await reads(focusSessions, focusSessions.id, {
        permissions: ["session.read"],
        workspaceIds: [W],
        projectIds: [P],
      })
    ).toEqual([SESS.p]); // in P, and counts in W through P's home (#1158); SESS.n is in W only
    expect(
      await reads(proposals, proposals.id, {
        permissions: ["proposal.read"],
        workspaceIds: [W],
        projectIds: [P],
      })
    ).toEqual(sorted(PROP.p, PROP.sess, PROP.trk));
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

describe("a non-create write is placed by its STORED row, never the door's projectId (W1 review)", () => {
  const P_KEY: GrantScope = {
    permissions: [
      "view.update",
      "profile.renderer.set",
      "profile.update",
      "track.update",
      "proposal.reject",
      "proposal.approve",
      "session.update",
      "session.read",
      "project.read",
    ],
    projectIds: [P],
  };
  const denial = (input: GrantWriteInput) =>
    runWithGrant(grantOfScope(P_KEY), () => grantWriteDenial(input));

  it("a lens or provenance projectId on a non-create write is no place", async () => {
    // A view update and a profile renderer bind, the X-Project-Id lens named P.
    expect(
      await denial({
        subjectType: "view",
        action: "update",
        workspaceId: W,
        projectId: P,
        data: { id: VIEW.q },
      })
    ).toMatch(/does not allow/);
    // Not vacuous: the same view write, placed by a door that read P from
    // the row, passes — the refusal above is the place, not the right.
    expect(
      await denial({
        subjectType: "view",
        action: "update",
        workspaceId: W,
        projectId: P,
        storedProjectIds: [P],
        data: { id: VIEW.q },
      })
    ).toBeNull();
    expect(
      await denial({
        subjectType: "profile",
        action: "renderer.set",
        workspaceId: W,
        projectId: P,
        data: { profileSlug: "task" },
      })
    ).toMatch(/does not allow/);
  });

  it("CONTROL — a goal is placed by its stored project; a door's stored flag counts", async () => {
    expect(
      await denial({
        subjectType: "track",
        action: "update",
        workspaceId: null,
        projectId: Q, // the door's value is not read for a stored goal
        data: { id: TRACK.p },
      })
    ).toBeNull();
    expect(
      await denial({
        subjectType: "track",
        action: "update",
        workspaceId: null,
        projectId: P,
        data: { id: TRACK.q },
      })
    ).toMatch(/does not allow/);
    // A door that read the session's project from its row (the answer door).
    const answer = {
      subjectType: "focus_session",
      action: "update",
      workspaceId: null,
      projectId: P,
    };
    expect(await denial({ ...answer, storedProjectIds: [P] })).toBeNull();
    expect(await denial(answer)).toMatch(/does not allow/);
  });

  it("a proposal is decided where its TARGET is: one stamped P about a record of Q is refused", async () => {
    const decide = (id: string) =>
      runWithGrant(grantOfScope(P_KEY), async () => {
        const [row] = (
          await q(
            `select id, workspace_id as "workspaceId", project_id as "projectId", target_type as "targetType", target_id as "targetId" from proposals where id = $1`,
            [id]
          )
        ).rows as Array<Record<string, string | null>>;
        assertMayDecideProposalAt(
          "reject",
          "reject",
          await withProposalTargetPlace(row!)
        );
      }).then(
        () => null,
        (e: unknown) => (e as Error).message
      );
    expect(await decide(PROP.q)).toMatch(/may not reject/);
    expect(await decide(PROP.n)).toMatch(/may not reject/);
    expect(await decide(PROP.odd)).toMatch(/may not reject/);
    expect(await decide(PROP.p)).toBeNull();
    expect(await decide(PROP.sess)).toBeNull();
  });

  it("a mixed-project orchestrate (sessions of P and Q) is refused at the grant rung", async () => {
    const err = await runWithGrant(grantOfScope(P_KEY), () =>
      startOrchestrator({
        userId: ALICE,
        input: { sessionIds: [SESS.p, SESS.q], brief: "coordinate" },
      })
    ).then(
      () => null,
      (e: unknown) => e as { code?: string; message: string }
    );
    expect(err?.code).toBe("FORBIDDEN");
    expect(err?.message).toMatch(/grant does not allow/);
    // The same gate input with every session in P passes rung 0.
    expect(
      await denial({
        subjectType: "focus_session",
        action: "orchestrate",
        workspaceId: null,
        projectId: P,
        storedProjectIds: [P],
        data: { id: randomUUID() },
      })
    ).toBeNull();
  });

  it("the agent's session filing gate refuses filing a session INTO P under a P pin (real gate, rung 0)", async () => {
    const decision = await runWithGrant(grantOfScope(P_KEY), () =>
      gateSessionFiling({
        userId: ALICE,
        agentUserId: randomUUID(),
        workspaceId: W,
        session: { id: SESS.n, goal: "g" },
        filing: { projectId: P },
      })
    );
    expect(decision.status).toBe("denied");
    expect((decision as { reason: string }).reason).toMatch(
      /grant does not allow/
    );
  });
});
