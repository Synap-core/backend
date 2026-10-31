/**
 * `notifCenter.handoff` — THE pod-mediated handoff door (decision D5) — and
 * its wrapper `requestHandoff` and read `handoffTargets`, driven through the
 * REAL procedures on PGlite with the whole schema.
 *
 * Real: the access door's read floors (`canRead` → `scopedDb`), every kind's
 * reader, `NotificationService.create` (registry row, materialized actions,
 * channel ceiling, push decision and the daily cap), the needs-you mapping of
 * the stored row, and the device reads (`person_devices`, push phones).
 *
 * Stubbed, and why:
 *  - `emitChatEvent` — the Socket.IO bridge; captured so the user-room emit is
 *    asserted.
 *  - `sendExpoPush` — a third-party HTTP hop; captured so "pushed / never
 *    pushed" is asserted.
 *  - `emitSideEffects` / `eventRepository.append` — fire-and-forget fan-out.
 *  - `isPodReadOnly` — every tRPC mutation's split-brain guard.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  emits: [] as Array<{ event: string; userId?: string; data: unknown }>,
  pushes: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});

vi.mock("../utils/chat-realtime-broadcast.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitChatEvent: (e: { event: string; userId?: string; data: unknown }) => {
      h.emits.push(e);
    },
  };
});

vi.mock("../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

vi.mock("../notifications/expo-push.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    sendExpoPush: async (payload: Record<string, unknown>) => {
      h.pushes.push(payload);
      return { sent: 1, revoked: 0, failed: 0 };
    },
  };
});

import { db } from "@synap/database";
import { HANDOFF_KINDS, type HandoffKind } from "@synap-core/types/navigation";
import { PUSH_DAILY_CAP } from "@synap-core/types/push";
import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { targetFromNotification } from "../services/signals/needs-you-union.js";
import { notifCenterRouter } from "./notif-center.js";

const OWNER = randomUUID();
const STRANGER = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string, extra: Record<string, unknown> = {}) =>
  notifCenterRouter.createCaller({
    db,
    authenticated: true,
    userId,
    ...extra,
  } as never);

type Row = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  source_type: string;
  source_id: string;
  status: string;
  actions: unknown;
  pushed: boolean;
};

const rowsFor = (sourceId: string) =>
  q<Row>(
    `select *, pushed_at is not null as pushed from notifications where source_id = $1`,
    [sourceId]
  ).then((r) => r.rows);

async function space(owner: string): Promise<string> {
  const ws = randomUUID();
  await q(
    `insert into workspaces (id, owner_id, name, settings) values ($1, $2, 'space', '{}'::jsonb)`,
    [ws, owner]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
    [ws, owner]
  );
  return ws;
}

/**
 * One readable object of each handoff kind, owned by `owner` in `ws`, named
 * `name`. A `Record` over `HandoffKind`: a kind added to `HANDOFF_KINDS`
 * without a fixture does not compile, so the "every kind" test below covers
 * it by existing.
 */
const MAKE: Record<
  HandoffKind,
  (owner: string, ws: string, name: string) => Promise<string>
> = {
  session: async (owner, ws, name) => {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, metadata, expected_outputs, criteria, created_at, updated_at, started_at)
       values ($1, $2, $3, 'the goal', $4, 'active', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now(), now())`,
      [id, owner, ws, name]
    );
    return id;
  },
  entity: async (owner, ws, name) => {
    const id = randomUUID();
    await q(
      `insert into entities (id, user_id, workspace_id, type, title, properties) values ($1, $2, $3, 'note', $4, '{}'::jsonb)`,
      [id, owner, ws, name]
    );
    return id;
  },
  document: async (owner, ws, name) => {
    const id = randomUUID();
    await q(
      `insert into documents (id, user_id, workspace_id, title, type) values ($1, $2, $3, $4, 'markdown')`,
      [id, owner, ws, name]
    );
    return id;
  },
  proposal: async (owner, ws) => {
    const id = randomUUID();
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by)
       values ($1, $2, 'entity', $3, 'create', '{}'::jsonb, 'pending', $4)`,
      [id, ws, randomUUID(), owner]
    );
    return id;
  },
  project: async (owner, ws, name) => {
    const id = randomUUID();
    await q(
      `insert into projects (id, user_id, workspace_id, name) values ($1, $2, $3, $4)`,
      [id, owner, ws, name]
    );
    return id;
  },
  track: async (owner, ws, name) => {
    const project = await MAKE.project(owner, ws, `${name} project`);
    const id = randomUUID();
    await q(
      `insert into project_tracks (id, project_id, user_id, name) values ($1, $2, $3, $4)`,
      [id, project, owner, name]
    );
    return id;
  },
  automation: async (owner, ws, name) => {
    const id = randomUUID();
    await q(
      `insert into automations (id, user_id, workspace_id, name) values ($1, $2, $3, $4)`,
      [id, owner, ws, name]
    );
    return id;
  },
  playbook: async (owner, ws, name) => {
    const id = randomUUID();
    await q(
      `insert into playbooks (id, user_id, workspace_id, name) values ($1, $2, $3, $4)`,
      [id, owner, ws, name]
    );
    return id;
  },
  library_group: async (owner, ws, name) => {
    const id = randomUUID();
    await q(
      `insert into library_groups (id, user_id, workspace_id, key, name, origin, outputs, build_proposal_ids)
       values ($1, $2, $3, $4, $5, 'user', '[]'::jsonb, '[]'::jsonb)`,
      [id, owner, ws, `k-${id.slice(0, 8)}`, name]
    );
    return id;
  },
};

async function signIn(
  owner: string,
  clientId: "synap-desktop" | "synap-relay",
  opts: { revoked?: boolean } = {}
) {
  await q(
    `insert into person_devices (id, user_id, client_id, label, created_at, last_used_at, expires_at, revoked_at)
     values (gen_random_uuid(), $1, $2, 'device', now(), now(), now() + interval '30 days', $3)`,
    [owner, clientId, opts.revoked ? new Date().toISOString() : null]
  );
}

async function pushPhone(owner: string) {
  await q(
    `insert into messaging_accounts (id, user_id, provider, external_id, status, metadata, created_at, updated_at)
     values (gen_random_uuid(), $1, 'expo', $2, 'connected', '{"platform":"ios"}'::jsonb, now(), now())`,
    [owner, `ExponentPushToken[${randomUUID()}]`]
  );
}

let ws: string;
let strangerWs: string;

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from notifications; delete from notification_preferences;
     delete from person_devices; delete from messaging_accounts;
     delete from focus_sessions; delete from entities; delete from documents;
     delete from proposals; delete from project_tracks; delete from projects;
     delete from automations; delete from playbooks; delete from library_groups;
     delete from workspace_members; delete from workspaces; delete from users;`
  );
  for (const u of [OWNER, STRANGER]) {
    await q(
      `insert into users (id, email, user_type, timezone) values ($1, $2, 'human', 'UTC')`,
      [u, `${u}@t`]
    );
  }
  ws = await space(OWNER);
  strangerWs = await space(STRANGER);
  h.emits.length = 0;
  h.pushes.length = 0;
});

describe("notifCenter.handoff", () => {
  it("to desktop: a session in its room — one in-app row, the button opens the ROOM, emitted live, never pushed", async () => {
    await signIn(OWNER, "synap-desktop");
    const id = await MAKE.session(OWNER, ws, "Capture · meeting notes");

    const result = await caller(OWNER).handoff({
      target: { kind: "session", id, view: "room" },
      to: "desktop",
    });

    expect(result).toMatchObject({
      status: "sent",
      to: "desktop",
      reach: { signedIn: true },
    });
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.notificationId,
      user_id: OWNER,
      type: "handoff.continue",
      source_type: "session",
      title: "Continue on desktop: Capture · meeting notes",
      status: "unread",
      pushed: false,
    });
    // The registry's own-object action, written in with the row's kind + view.
    expect(rows[0]!.actions).toEqual([
      {
        id: "open",
        label: "Open",
        variant: "primary",
        handler: { type: "navigate-object", kind: "session", view: "room" },
      },
    ]);
    expect(
      targetFromNotification(rows[0]!.source_type, id, rows[0]!.actions)
    ).toEqual({ kind: "session", id, view: "room" });

    const live = h.emits.find((e) => e.event === "notification:new");
    expect(live?.userId).toBe(OWNER);
    expect(
      (live!.data as { notification: Record<string, unknown> }).notification
    ).toMatchObject({
      type: "handoff.continue",
      sourceType: "session",
      sourceId: id,
      actions: rows[0]!.actions,
    });
    expect(h.pushes).toHaveLength(0);
  });

  it("every HANDOFF_KINDS member: its object is read, named, stored under its own kind, and opens as itself from the inbox", async () => {
    expect(HANDOFF_KINDS.length).toBeGreaterThanOrEqual(9);
    for (const kind of HANDOFF_KINDS) {
      const id = await MAKE[kind](OWNER, ws, `A ${kind} thing`);
      const result = await caller(OWNER).handoff({
        target: { kind, id },
        to: "desktop",
      });
      expect(result.status, kind).toBe("sent");
      const [row] = await rowsFor(id);
      expect(row?.source_type, kind).toBe(kind);
      // A proposal is named by the shared fallback title, never its id.
      if (kind === "proposal") {
        expect(row!.title).toMatch(/^Continue on desktop: \S/);
        expect(row!.title).not.toContain(id);
      } else {
        expect(row!.title, kind).toBe(`Continue on desktop: A ${kind} thing`);
      }
      expect(
        targetFromNotification(row!.source_type, id, row!.actions),
        kind
      ).toEqual({ kind, id });
    }
  });

  it("an object the person cannot read answers the SAME not-found as a missing one, for every kind, and writes nothing", async () => {
    for (const kind of HANDOFF_KINDS) {
      const theirs = await MAKE[kind](STRANGER, strangerWs, "Theirs");
      const errs = await Promise.all(
        [theirs, randomUUID()].map((id) =>
          caller(OWNER)
            .handoff({ target: { kind, id }, to: "phone" })
            .then(
              () => null,
              (e: { code?: string; message?: string }) => ({
                code: e.code,
                message: e.message,
              })
            )
        )
      );
      expect(errs[0]?.code, kind).toBe("NOT_FOUND");
      expect(errs[1], kind).toEqual(errs[0]);
      expect(await rowsFor(theirs), kind).toHaveLength(0);
    }
    expect(h.pushes).toHaveLength(0);
  });

  it("to phone: an in-app row AND a push whose tap opens the object, under `sent-by-you`, past the daily cap", async () => {
    await pushPhone(OWNER);
    // The person already had their day's pushes: a cap-counted push would be
    // held back here; their own ask is not.
    for (let n = 0; n < PUSH_DAILY_CAP; n++) {
      await q(
        `insert into notifications (id, user_id, type, category, priority, title, body, source_type, status, actions, pushed_at, created_at)
         values (gen_random_uuid(), $1, 'entity.signal', 'system', 'normal', 't', 'b', 'entity', 'unread', '[]'::jsonb, now(), now())`,
        [OWNER]
      );
    }
    const id = await MAKE.entity(OWNER, ws, "Acme contract");

    const result = await caller(OWNER).handoff({
      target: { kind: "entity", id },
      to: "phone",
    });

    expect(result).toMatchObject({
      status: "sent",
      to: "phone",
      reach: { signedIn: true, push: true },
    });
    const [row] = await rowsFor(id);
    expect(row).toMatchObject({
      type: "handoff.to_phone",
      source_type: "entity",
      title: "From your desktop: Acme contract",
      pushed: true,
    });
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({
      userId: OWNER,
      data: expect.objectContaining({
        kind: "entity",
        id,
        pushCategory: "sent-by-you",
      }),
    });
  });

  it("refuses a view where it does not apply, before reading anything", async () => {
    const id = await MAKE.entity(OWNER, ws, "x");
    await expect(
      caller(OWNER).handoff({
        target: { kind: "entity", id, view: "room" },
        to: "desktop",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await rowsFor(id)).toHaveLength(0);
  });

  it("refuses an AGENT caller — a handoff is a person's own device act", async () => {
    const id = await MAKE.document(OWNER, ws, "Spec");
    await expect(
      caller(OWNER, { agentUserId: randomUUID() }).handoff({
        target: { kind: "document", id },
        to: "phone",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await rowsFor(id)).toHaveLength(0);
  });

  it("a double tap inside the window reuses the unread row; the other direction is its own request", async () => {
    const id = await MAKE.playbook(OWNER, ws, "Weekly review");
    const first = await caller(OWNER).handoff({
      target: { kind: "playbook", id },
      to: "desktop",
    });
    const again = await caller(OWNER).handoff({
      target: { kind: "playbook", id },
      to: "desktop",
    });
    expect(again).toMatchObject({
      status: "already_sent",
      notificationId: first.notificationId,
    });
    const other = await caller(OWNER).handoff({
      target: { kind: "playbook", id },
      to: "phone",
    });
    expect(other.status).toBe("sent");
    expect((await rowsFor(id)).map((r) => r.type).sort()).toEqual([
      "handoff.continue",
      "handoff.to_phone",
    ]);
  });
});

describe("notifCenter.handoffTargets", () => {
  it("reads the person's own live sign-ins and push phones; a revoked sign-in and another person's device do not count", async () => {
    expect(await caller(OWNER).handoffTargets()).toEqual({
      desktop: { signedIn: false, lastSeenAt: null },
      phone: { signedIn: false, lastSeenAt: null, push: false },
    });

    await signIn(OWNER, "synap-desktop", { revoked: true });
    await signIn(STRANGER, "synap-desktop");
    await pushPhone(STRANGER);
    expect((await caller(OWNER).handoffTargets()).desktop.signedIn).toBe(false);
    expect((await caller(OWNER).handoffTargets()).phone.signedIn).toBe(false);

    await signIn(OWNER, "synap-desktop");
    await signIn(OWNER, "synap-relay");
    const reach = await caller(OWNER).handoffTargets();
    expect(reach.desktop.signedIn).toBe(true);
    expect(reach.desktop.lastSeenAt).toMatch(/^\d{4}-/);
    // Signed in on relay, but no push registration: it waits in the app.
    expect(reach.phone).toMatchObject({ signedIn: true, push: false });
  });
});

describe("notifCenter.requestHandoff (the wrapper)", () => {
  it("still hands a session's room and a Library group to the desktop, through the one door", async () => {
    const session = await MAKE.session(OWNER, ws, "Import run");
    const group = await MAKE.library_group(OWNER, ws, "Recipes to try");

    const s = await caller(OWNER).requestHandoff({
      target: { kind: "session", id: session },
      view: "room",
    });
    const g = await caller(OWNER).requestHandoff({
      target: { kind: "library_group", id: group },
    });
    expect(Object.keys(s).sort()).toEqual(["notificationId", "status"]);
    expect(g.status).toBe("sent");

    const [groupRow] = await rowsFor(group);
    expect(groupRow).toMatchObject({
      type: "handoff.continue",
      source_type: "library_group",
      title: "Continue on desktop: Recipes to try",
    });
    expect(
      targetFromNotification("library_group", group, groupRow!.actions)
    ).toEqual({ kind: "library_group", id: group });
    expect(
      targetFromNotification(
        "session",
        session,
        (await rowsFor(session))[0]!.actions
      )
    ).toEqual({ kind: "session", id: session, view: "room" });

    // Its old contract stays: a session needs `room`, a group takes no view.
    await expect(
      caller(OWNER).requestHandoff({
        target: { kind: "session", id: session },
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller(OWNER).requestHandoff({
        target: { kind: "library_group", id: group },
        view: "room",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
