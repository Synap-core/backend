/**
 * The move and share doors (`services/move-to-space.ts`) on PGlite, through
 * the real floor (`assertWorkspaceWrite`) and the real readers of "usable
 * here": the run door's refusal (`playbookRunRefusal`) and the skill floor
 * (`visibleSkillsWhere`), and the access registry's playbook rule. The
 * governance gate is a seam: that an agent's `workspace.update` always proposes
 * is the ADMIN floor's (governance-policy), not this door's.
 *
 *   - a playbook moves with the automations linked to it at its home; one
 *     linked from elsewhere stays; its grant to the new home is dropped;
 *   - a person moves or shares only into a space they write, and an agent
 *     only through its person's membership: refused before anything is filed;
 *   - an agent's move is filed on the destination as the agent, and the door
 *     writes nothing while the gate holds it;
 *   - a name the destination already has is a conflict, nothing moves;
 *   - a share makes a playbook runnable and a skill visible in that space,
 *     and readable by a member of only that space, who still cannot edit it;
 *     revoking it takes that back.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  checkPermission: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: (...a: unknown[]) => h.checkPermission(...a),
}));

import { and, db, eq } from "@synap/database";
import { playbooks, skills } from "@synap/database/schema";
import type { Context } from "../../context.js";
import { AccessContext, scopedDb } from "../../access/index.js";
import { playbooksRouter } from "../../routers/playbooks.js";
import {
  allSchemaTables,
  pgliteSchemaDdl,
} from "../../__tests__/pglite-ddl.js";
import { moveToSpace, shareWithSpace } from "../move-to-space.js";
import { playbookRunRefusal } from "../playbooks/playbook-lifecycle.js";
import { visibleSkillsWhere } from "../skills/visibility.js";

const PERSON = randomUUID();
const AGENT = randomUUID();
const OUTSIDER = randomUUID();
/** A member of the target space only. */
const READER = randomUUID();
let A = "";
let B = "";
let C = "";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function space(name: string, members: string[]): Promise<string> {
  const id = randomUUID();
  await q(`insert into workspaces (id, name, owner_id) values ($1,$2,$3)`, [
    id,
    name,
    members[0] ?? OUTSIDER,
  ]);
  for (const m of members) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
      [randomUUID(), id, m]
    );
  }
  return id;
}

async function playbook(
  name: string,
  workspaceId: string | null,
  opts: { owner?: string; stages?: unknown[] } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, status, stages) values ($1,$2,$3,$4,'g','active',$5::jsonb)`,
    [
      id,
      workspaceId,
      opts.owner ?? PERSON,
      name,
      JSON.stringify(opts.stages ?? []),
    ]
  );
  return id;
}

async function automation(
  name: string,
  workspaceId: string | null,
  playbookId?: string,
  opts: { owner?: string; flow?: unknown } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, status, flow_definition) values ($1,$2,$3,$4,'cron','active',$5::jsonb)`,
    [
      id,
      workspaceId,
      opts.owner ?? PERSON,
      name,
      JSON.stringify(opts.flow ?? { nodes: [], edges: [] }),
    ]
  );
  if (playbookId) {
    await q(
      `insert into playbook_automations (playbook_id, automation_id, role) values ($1,$2,'activator')`,
      [playbookId, id]
    );
  }
  return id;
}

const homeOf = async (table: string, id: string) =>
  (
    await q<{ workspace_id: string | null }>(
      `select workspace_id from ${table} where id = $1`,
      [id]
    )
  ).rows[0]!.workspace_id;

const grants = async (objectId: string) =>
  (
    await q<{ workspace_id: string; granted_by: string | null }>(
      `select workspace_id, granted_by from space_access where object_id = $1 order by workspace_id`,
      [objectId]
    )
  ).rows;

const runRefusal = async (id: string, workspaceId: string) => {
  const [row] = (
    await q<{
      id: string;
      name: string;
      workspace_id: string;
      status: "draft" | "active" | "paused" | "archived";
    }>(`select id, name, workspace_id, status from playbooks where id = $1`, [
      id,
    ])
  ).rows;
  return playbookRunRefusal(
    {
      id: row!.id,
      name: row!.name,
      workspaceId: row!.workspace_id,
      status: row!.status,
    },
    workspaceId,
    db
  );
};

beforeEach(async () => {
  await h.client!.exec(`drop schema public cascade; create schema public;`);
  await h.client!.exec(pgliteSchemaDdl(allSchemaTables()));
  for (const id of [PERSON, OUTSIDER, READER]) {
    await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
      id,
      `${id}@x.test`,
    ]);
  }
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,'agent@x.test','agent',$2)`,
    [AGENT, PERSON]
  );
  A = await space("Ecosystem", [PERSON]);
  B = await space("Reprise", [PERSON, READER]);
  C = await space("Theirs", [OUTSIDER]);
  h.checkPermission.mockReset().mockResolvedValue({ granted: true });
});

/** The playbook as `userId` reads it through the access registry, or undefined. */
const readAs = (userId: string, id: string) =>
  scopedDb(AccessContext.operator({ userId })).findFirst<{ id: string }>(
    playbooks,
    { where: eq(playbooks.id, id) }
  );

describe("moveToSpace — a playbook carries its automations", () => {
  it("moves the playbook and its automations at its home; a pod-wide one linked to it stays", async () => {
    const pb = await playbook("Dossier de reprise", A);
    const own = await automation("Dossier: retenue", A, pb);
    const podWide = await automation("Weekly digest", null, pb);
    await q(
      `insert into space_access (object_type, object_id, workspace_id) values ('playbook',$1,$2)`,
      [pb, B]
    );

    const out = await moveToSpace({
      userId: PERSON,
      objectType: "playbook",
      objectId: pb,
      workspaceId: B,
    });

    expect(out).toMatchObject({ status: "moved", carriedAutomationIds: [own] });
    expect(await homeOf("playbooks", pb)).toBe(B);
    expect(await homeOf("automations", own)).toBe(B);
    expect(await homeOf("automations", podWide)).toBeNull();
    expect(await grants(pb)).toEqual([]);
    expect(h.checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "workspace",
        action: "update",
        workspaceId: B,
        data: expect.objectContaining({
          id: B,
          operation: "move_in",
          objectType: "playbook",
          objectId: pb,
        }),
      })
    );
    expect(await runRefusal(pb, B)).toBeNull();
  });

  it("a person cannot move into a space they are not a member of: refused before any request", async () => {
    const pb = await playbook("Dossier de reprise", A);
    await expect(
      moveToSpace({
        userId: PERSON,
        objectType: "playbook",
        objectId: pb,
        workspaceId: C,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.checkPermission).not.toHaveBeenCalled();
    expect(await homeOf("playbooks", pb)).toBe(A);
  });

  it("a person who writes the destination but not the object's home is refused before any request", async () => {
    const pb = await playbook("Their playbook", C, { owner: OUTSIDER });
    await expect(
      moveToSpace({
        userId: PERSON,
        objectType: "playbook",
        objectId: pb,
        workspaceId: B,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/do not write the space it lives in/),
    });
    expect(h.checkPermission).not.toHaveBeenCalled();
    expect(await homeOf("playbooks", pb)).toBe(C);
  });

  it("a pod-wide playbook does not carry someone else's pod-wide automation", async () => {
    const pb = await playbook("Pod-wide digest", null);
    const theirs = await automation("Their digest", null, pb, {
      owner: OUTSIDER,
    });
    await expect(
      moveToSpace({
        userId: PERSON,
        objectType: "playbook",
        objectId: pb,
        workspaceId: B,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/Their digest/),
    });
    expect(await homeOf("playbooks", pb)).toBeNull();
    expect(await homeOf("automations", theirs)).toBeNull();
  });

  it("a move that would break what stays behind is refused, naming each one", async () => {
    const pb = await playbook("Dossier de reprise", A);
    await playbook("Suivi", A, {
      stages: [{ key: "dossier", uses: { playbookId: pb, version: 1 } }],
    });
    await automation("Weekly run", A, undefined, {
      flow: { nodes: [{ id: "n1", type: "playbook_run", playbookId: pb }] },
    });
    const other = await playbook("Autre", A);
    await automation("Shared schedule", A, pb);
    await q(
      `insert into playbook_automations (playbook_id, automation_id, role) select $1, id, 'activator' from automations where name = 'Shared schedule'`,
      [other]
    );
    const err = await moveToSpace({
      userId: PERSON,
      objectType: "playbook",
      objectId: pb,
      workspaceId: B,
    }).catch((e: unknown) => e as { code: string; message: string });
    expect(err).toMatchObject({ code: "PRECONDITION_FAILED" });
    const message = (err as { message: string }).message;
    expect(message).toMatch(/playbook "Suivi" \(uses it\)/);
    expect(message).toMatch(/automation "Weekly run" \(runs it\)/);
    expect(message).toMatch(
      /automation "Shared schedule" \(it also runs another playbook\)/
    );
    expect(h.checkPermission).not.toHaveBeenCalled();
    expect(await homeOf("playbooks", pb)).toBe(A);
  });

  it("a move to where it already lives changes nothing and files nothing", async () => {
    const pb = await playbook("Dossier de reprise", A);
    await expect(
      moveToSpace({
        userId: PERSON,
        agentUserId: AGENT,
        objectType: "playbook",
        objectId: pb,
        workspaceId: A,
      })
    ).resolves.toMatchObject({ status: "unchanged" });
    expect(h.checkPermission).not.toHaveBeenCalled();
  });

  it("an agent acts through its person's membership: outside it, refused before any request", async () => {
    const pb = await playbook("Dossier de reprise", A);
    await expect(
      moveToSpace({
        userId: AGENT,
        agentUserId: AGENT,
        objectType: "playbook",
        objectId: pb,
        workspaceId: C,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.checkPermission).not.toHaveBeenCalled();
  });

  it("an agent's move into its person's space is filed on that space, as the agent; nothing moves until approved", async () => {
    const pb = await playbook("Dossier de reprise", A);
    h.checkPermission.mockResolvedValue({
      granted: false,
      proposalId: "p-1",
      reviewUrl: "https://pod.test/open/p-1",
    });
    const out = await moveToSpace({
      userId: AGENT,
      agentUserId: AGENT,
      objectType: "playbook",
      objectId: pb,
      workspaceId: B,
    });
    expect(out).toEqual({
      status: "proposed",
      proposalId: "p-1",
      reviewUrl: "https://pod.test/open/p-1",
    });
    expect(h.checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: AGENT,
        subjectType: "workspace",
        action: "update",
        workspaceId: B,
        data: expect.objectContaining({ operation: "move_in", objectId: pb }),
      })
    );
    expect(await homeOf("playbooks", pb)).toBe(A);
  });

  it("a name the destination already has is a conflict; nothing moves", async () => {
    const pb = await playbook("Dossier de reprise", A);
    const own = await automation("Dossier: retenue", A, pb);
    await automation("dossier: RETENUE", B);
    await expect(
      moveToSpace({
        userId: PERSON,
        objectType: "playbook",
        objectId: pb,
        workspaceId: B,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await homeOf("playbooks", pb)).toBe(A);
    expect(await homeOf("automations", own)).toBe(A);
  });
});

describe("shareWithSpace — usable there, home unchanged", () => {
  it("a shared playbook runs in the space it is shared with, and not once revoked", async () => {
    const pb = await playbook("Valider une source", A);
    expect(await runRefusal(pb, B)).toMatch(/lives in space/);

    await expect(
      shareWithSpace({
        userId: PERSON,
        objectType: "playbook",
        objectId: pb,
        workspaceId: B,
      })
    ).resolves.toMatchObject({ status: "shared" });
    expect(await grants(pb)).toEqual([{ workspace_id: B, granted_by: PERSON }]);
    expect(await homeOf("playbooks", pb)).toBe(A);
    expect(await runRefusal(pb, B)).toBeNull();

    await shareWithSpace({
      userId: PERSON,
      objectType: "playbook",
      objectId: pb,
      workspaceId: B,
      revoke: true,
    });
    expect(await runRefusal(pb, B)).toMatch(/lives in space/);
  });

  it("a member of only the target space reads and runs a shared playbook, never edits it; revoking removes it", async () => {
    const pb = await playbook("Valider une source", A);
    expect(await readAs(READER, pb)).toBeUndefined();

    await shareWithSpace({
      userId: PERSON,
      objectType: "playbook",
      objectId: pb,
      workspaceId: B,
    });
    expect(await readAs(READER, pb)).toMatchObject({ id: pb });
    expect(await runRefusal(pb, B)).toBeNull();
    const asReader = playbooksRouter.createCaller({
      db,
      authenticated: true,
      userId: READER,
      workspaceId: B,
    } as unknown as Context);
    await expect(
      asReader.update({ id: pb, description: "edited from Reprise" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await shareWithSpace({
      userId: PERSON,
      objectType: "playbook",
      objectId: pb,
      workspaceId: B,
      revoke: true,
    });
    expect(await readAs(READER, pb)).toBeUndefined();
  });

  it("a person cannot share into a space they are not a member of", async () => {
    const pb = await playbook("Valider une source", A);
    await expect(
      shareWithSpace({
        userId: PERSON,
        agentUserId: AGENT,
        objectType: "playbook",
        objectId: pb,
        workspaceId: C,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.checkPermission).not.toHaveBeenCalled();
    expect(await grants(pb)).toEqual([]);
  });

  it("a shared skill is one of the space's skills, for a member of only that space too", async () => {
    const skill = randomUUID();
    await q(
      `insert into skills (id, user_id, workspace_id, scope, name, slug, kind) values ($1,$2,$3,'workspace','Cession checklist','cession-checklist','instruction')`,
      [skill, PERSON, A]
    );
    const inB = async (userId: string) =>
      (
        await db
          .select({ id: skills.id })
          .from(skills)
          .where(and(visibleSkillsWhere(userId, B)))
      ).map((r) => r.id);
    expect(await inB(PERSON)).toEqual([]);
    expect(await inB(READER)).toEqual([]);

    await shareWithSpace({
      userId: PERSON,
      objectType: "skill",
      objectId: skill,
      workspaceId: B,
    });
    expect(await inB(PERSON)).toEqual([skill]);
    expect(await inB(READER)).toEqual([skill]);

    await shareWithSpace({
      userId: PERSON,
      objectType: "skill",
      objectId: skill,
      workspaceId: B,
      revoke: true,
    });
    expect(await inB(READER)).toEqual([]);
  });
});
