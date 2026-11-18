/**
 * Where a project-only session COUNTS for a key's grant (founder decision of
 * 18 Nov 2026, "count the project's spaces", amending e1b59d38 "B"): a session
 * with no space, filed in a project, counts in the project's home space and in
 * every space the project uses (`project_use_workspace`); one with a space
 * counts there only; one with neither counts nowhere.
 *
 * On PGlite, through the real resolver (`sessionGrantWorkspaceId`) feeding the
 * real grant check (`grantWriteDenial`, the gate's rung 0), the real grant read
 * clauses (`keyGrantReadClause`, `scopedDb`), and the real `uses` door
 * (`linkProjectToWorkspace`).
 *
 * Rows rule out:
 *   - a project-only session refused under a grant on its project's HOME
 *     (P_HOME) or on a space the project USES (P_USES) — the gap this closes;
 *   - a session counted in a space its project does not use (Q_ONLY), or a
 *     session with neither space nor project counted anywhere (ORPHAN);
 *   - a session WITH a space widened to its project's spaces (OWN_FIN: its own
 *     space wins, only there);
 *   - a grant that holds only `channel.read` writing (the permission still
 *     decides, the space only places it);
 *   - the read half drifting from the write half (parity row);
 *   - a BORROWED channel read through the session that borrowed it;
 *   - an app stamping a `uses` edge, which would widen its own reach.
 *
 * Cannot see: production Postgres constraints (tables from the Drizzle
 * definitions without FKs / enums). The doors end to end: the room post rows
 * of `threads.room-write-grant.pglite.test.ts`.
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
import { channels, focusSessions } from "@synap/database/schema";
import {
  grantOfScope,
  inArray,
  runWithGrant,
  and,
  type KeyGrant,
} from "@synap/database";
import type { GrantScope } from "@synap/governance-policy/grants";
import { AccessContext, scopedDb } from "./index.js";
import { keyGrantReadClause } from "./grant-read.js";
import {
  sessionCountedSpaceIds,
  sessionCountsInSpacesWhere,
  sessionGrantWorkspaceId,
} from "./session-counted-spaces.js";
import { grantWriteDenial } from "../utils/grant-write-check.js";
import { linkProjectToWorkspace } from "../utils/project-workspace.js";

const PERSON = randomUUID();
const CONTENT = randomUUID(); // the space the app is granted
const FINANCE = randomUUID(); // a space it is not

const P_HOME = randomUUID(); // project homed in CONTENT
const P_USES = randomUUID(); // pod-personal project that USES CONTENT
const Q_ONLY = randomUUID(); // pod-personal project that uses FINANCE only
const P_NEW = randomUUID(); // pod-personal project, no space yet

const S = {
  pHome: randomUUID(), // project-only, P_HOME          → counts in CONTENT
  pUses: randomUUID(), // project-only, P_USES          → counts in CONTENT
  qOnly: randomUUID(), // project-only, Q_ONLY          → FINANCE only
  orphan: randomUUID(), // no space, no project          → nowhere
  ownFin: randomUUID(), // own space FINANCE, in P_USES  → FINANCE only
  ownContent: randomUUID(), // own space CONTENT         → CONTENT
};
const ROOM = { pUses: randomUUID(), qOnly: randomUUID() };
/** A chat the P_USES session BORROWED as its room: not minted for it. */
const BORROWED = randomUUID();

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
const sorted = (ids: string[]) => [...new Set(ids)].sort();

const usesEdge = (project: string, ws: string) =>
  q(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata)
     values ($1,$2,'project',$3,'workspace',$2,'uses','{}'::jsonb)`,
    [randomUUID(), ws, project]
  );

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );

  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    PERSON,
    `${PERSON}@x.test`,
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), PERSON]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Content OS',$3,'{}'::jsonb),($2,'Finance',$3,'{}'::jsonb)`,
    [CONTENT, FINANCE, PERSON]
  );
  for (const ws of [CONTENT, FINANCE]) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, PERSON]
    );
  }
  for (const [id, home] of [
    [P_HOME, CONTENT],
    [P_USES, null],
    [Q_ONLY, null],
    [P_NEW, null],
  ] as const) {
    await q(
      `insert into projects (id, user_id, workspace_id, name) values ($1,$2,$3,'Project')`,
      [id, PERSON, home]
    );
  }
  await usesEdge(P_USES, CONTENT);
  await usesEdge(Q_ONLY, FINANCE);

  const session = (
    id: string,
    ws: string | null,
    project: string | null,
    room: string | null = null
  ) =>
    q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, channel_id, goal, status, expected_outputs, metadata)
       values ($1,$2,$3,$4,$5,'Ship it','active','[]'::jsonb,'{}'::jsonb)`,
      [id, PERSON, ws, project, room]
    );
  await session(S.pHome, null, P_HOME);
  await session(S.pUses, null, P_USES, ROOM.pUses);
  await session(S.qOnly, null, Q_ONLY, ROOM.qOnly);
  await session(S.orphan, null, null);
  await session(S.ownFin, FINANCE, P_USES);
  await session(S.ownContent, CONTENT, null);

  // Session rooms as `ensureSessionChannel` mints them for a session with no
  // space: pod-wide, stamped with the session.
  const channel = (id: string, sessionId: string | null) =>
    q(
      `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id, metadata)
       values ($1,$2,null,'group','pod','active','Room',$3,$4,'{}'::jsonb)`,
      [id, PERSON, sessionId ? "focus_session" : null, sessionId]
    );
  await channel(ROOM.pUses, S.pUses);
  await channel(ROOM.qOnly, S.qOnly);
  // Borrowed: the P_USES session's `channel_id` does not point at it, and its
  // stamp names the session (as `channel.ensure` lets anyone stamp one).
  await channel(BORROWED, S.pUses);
}, 120_000);

const CONTENT_SESSION_UPDATE: GrantScope = {
  permissions: ["session.update", "session.read", "channel.read"],
  workspaceIds: [CONTENT],
};
const APP = (scope: GrantScope): KeyGrant => grantOfScope(scope, "app-public");

const row = async (id: string) => {
  const [r] = await (h.db as any)
    .select({
      workspaceId: focusSessions.workspaceId,
      projectId: focusSessions.projectId,
    })
    .from(focusSessions)
    .where(inArray(focusSessions.id, [id]));
  return r as { workspaceId: string | null; projectId: string | null };
};

/** The gate's rung 0 for an update of this session, placed by the resolver. */
const updateDenied = async (sessionId: string, grant: KeyGrant) =>
  runWithGrant(grant, async () => {
    const write = {
      subjectType: "focus_session",
      action: "update",
      data: { id: sessionId },
    };
    const workspaceId = await sessionGrantWorkspaceId(
      await row(sessionId),
      write
    );
    return grantWriteDenial({ ...write, workspaceId });
  });

describe("WRITE — an app granted session.update on Content OS", () => {
  const grant = APP(CONTENT_SESSION_UPDATE);

  it("updates a project-only session whose project is HOMED in Content OS", async () => {
    expect(await updateDenied(S.pHome, grant)).toBeNull();
  });

  it("updates a project-only session whose project USES Content OS", async () => {
    expect(await updateDenied(S.pUses, grant)).toBeNull();
  });

  it("NOT one whose project uses only Finance", async () => {
    expect(await updateDenied(S.qOnly, grant)).toMatch(
      /grant does not allow "session\.update"/
    );
  });

  it("NOT a session with neither space nor project", async () => {
    expect(await updateDenied(S.orphan, grant)).toMatch(
      /grant does not allow "session\.update"/
    );
  });

  it("NOT a session with its OWN space elsewhere, whatever its project uses", async () => {
    expect(await updateDenied(S.ownFin, grant)).toMatch(
      /grant does not allow "session\.update" in workspace/
    );
  });

  it("a session in Content OS itself, as before", async () => {
    expect(await updateDenied(S.ownContent, grant)).toBeNull();
  });

  it("the space only PLACES the write: a grant that only reads there writes nothing", async () => {
    const readOnly = APP({
      permissions: ["session.read", "channel.read"],
      workspaceIds: [CONTENT],
    });
    for (const id of [S.pHome, S.pUses])
      expect(await updateDenied(id, readOnly)).toMatch(/session\.update/);
  });

  it("no grant (a signed-in person): the session's own space, nothing read", async () => {
    expect(
      await sessionGrantWorkspaceId(
        { workspaceId: null, projectId: P_USES },
        { subjectType: "focus_session", action: "update" },
        undefined
      )
    ).toBeNull();
  });
});

describe("READ — the same rule, as the grant read clauses", () => {
  const readSessions = (scope?: GrantScope) => {
    const run = () =>
      scopedDb(AccessContext.operator({ userId: PERSON })).findMany<{
        id: string;
      }>(focusSessions);
    return (scope ? runWithGrant(APP(scope), run) : run()).then((rows) =>
      sorted(rows.map((r) => r.id))
    );
  };

  it("CONTROL — no grant: the person's floor reads every session", async () => {
    const seen = await readSessions();
    for (const id of Object.values(S)) expect(seen).toContain(id);
  });

  it("session.read on Content OS reads the sessions that count there, and only those", async () => {
    expect(await readSessions(CONTENT_SESSION_UPDATE)).toEqual(
      sorted([S.pHome, S.pUses, S.ownContent])
    );
  });

  it("channel.read on Content OS reads the minted room of a session that counts there — not another's, not a borrowed chat", async () => {
    const clause = keyGrantReadClause(channels, APP(CONTENT_SESSION_UPDATE));
    const rows = (await (h.db as any)
      .select({ id: channels.id })
      .from(channels)
      .where(
        and(inArray(channels.id, [ROOM.pUses, ROOM.qOnly, BORROWED]), clause)
      )) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual([ROOM.pUses]);
  });

  it("PARITY — the read clause and the write resolver agree on every space-less session", async () => {
    for (const space of [CONTENT, FINANCE]) {
      const readable = (
        (await (h.db as any)
          .select({ id: focusSessions.id })
          .from(focusSessions)
          .where(sessionCountsInSpacesWhere([space]))) as { id: string }[]
      ).map((r) => r.id);
      for (const id of [S.pHome, S.pUses, S.qOnly, S.orphan]) {
        const counted = await sessionCountedSpaceIds(await row(id));
        expect(readable.includes(id), `${id} in ${space}`).toBe(
          counted.includes(space)
        );
      }
    }
  });
});

describe("an app never adds a space to a project (that would widen its own reach)", () => {
  it("the uses stamp is refused under an app's grant, and no edge is written", async () => {
    const res = await runWithGrant(APP(CONTENT_SESSION_UPDATE), () =>
      linkProjectToWorkspace(h.db as never, {
        projectId: P_NEW,
        workspaceId: CONTENT,
        userId: PERSON,
      })
    );
    expect(res).toEqual({ linked: false, reason: "app_grant" });
    expect(
      await sessionCountedSpaceIds({ workspaceId: null, projectId: P_NEW })
    ).toEqual([]);
  });

  it("CONTROL — the person's own key (no app) stamps it", async () => {
    const res = await runWithGrant(grantOfScope({ permissions: ["*"] }), () =>
      linkProjectToWorkspace(h.db as never, {
        projectId: P_NEW,
        workspaceId: CONTENT,
        userId: PERSON,
      })
    );
    expect(res.linked).toBe(true);
    expect(
      await sessionCountedSpaceIds({ workspaceId: null, projectId: P_NEW })
    ).toEqual([CONTENT]);
  });
});
