/**
 * A playbook run reads sessions only through the PERSON it runs for, and only
 * the sessions that person OWNS (founder decision: runs keep `list_sessions`
 * and `get_session` as run-history reads, plan fbfadf54 fix 1.5;
 * `LONG_RUN_FLOOR` in `@synap/playbooks` run-tools).
 *
 * The path a run's read takes: the IS tool (`get_session` / `list_sessions`,
 * intelligence-hub `focus-session-tools.ts`) calls
 * `GET /api/hub/focus-sessions/:id?workspaceId=<run's space>` and
 * `GET /api/hub/focus-sessions?workspaceId=<run's space>&status&limit` with the
 * turn's pod-signed delegation (`sub` = the run's person, `act.sub` = their
 * house agent; `is-delegation.ts`). The hub auth door makes `sub` the request's
 * `userId` (`authenticateIsDelegation`), and both routes floor on
 * `sessionReadableWhere({ userId })` with no roster branch: owner-only, the
 * same owner the write doors (`update_run`'s PATCH) floor on.
 *
 * Driven through the REAL hub auth door with a REAL pod-signed delegation
 * (`mintIsDelegationToken`, a real key file), the REAL routes and the REAL
 * floors as SQL on PGlite. Stubbed: the guest check, the IS-origin check, and
 * the two packet projections (`projectContinuationPacket`,
 * `readSessionOutcomesSection`), which are not under test; a sentinel proves
 * the route reached them for THIS session as THIS person.
 *
 * Rows rule out:
 *  - another person's private session in a space both share (a floor that
 *    trusts the workspace lens alone);
 *  - another person's session whose own room seats the run's person as a human
 *    (the roster branch is a HUMAN-door widening, decision C; an agent door
 *    reads owner-only) — the fixture is proved a real seat by the human door;
 *  - a session in a space the person is not a member of (403 with that lens,
 *    404 without);
 *  - another person's pod-personal session (no space);
 *  - a `?userId=` naming another person: the delegation's key type is
 *    `is_internal`, an override type that MAY name another user on doors that
 *    read a userId — these two doors must not read one;
 *  - the run's lens widening: the person's own session in another space is
 *    not in the run space's list (a lens only narrows).
 *
 * Cannot see: the IS itself (its tools pass only `sessionId` / `status` /
 * `limit`, never a userId), production Postgres, the packet's own sections
 * (room, outcomes), which read as the same `userId`.
 */
import crypto, { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  knownOrigins: new Set<string>(),
  packet: vi.fn(),
  outcomes: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("@synap/intelligence-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isIntelligenceServiceOrigin: async (origin: string) =>
    h.knownOrigins.has(origin),
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/focus-sessions/continuation-packet.js", () => ({
  projectContinuationPacket: (...a: unknown[]) => h.packet(...a),
}));
vi.mock(
  "../../../services/focus-sessions/session-outputs.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    readSessionOutcomesSection: (...a: unknown[]) => h.outcomes(...a),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  _resetPodIdentityForTest,
  mintIsDelegationToken,
} from "@synap/database";
// Registers the grant read provider the floors call, as the API does at load.
import "../../../access/grant-read.js";
import { sessionReaderIds } from "../../../access/session-visibility.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerFocusSessionsRoutes } from "./focus-sessions.js";
import type { HubHono, HubVariables } from "./_shared.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const IS = "https://intelligence.synap.test";
const PERSON = randomUUID(); // the run's person: the turn's operator (`sub`)
const HOUSE = randomUUID(); // PERSON's house agent: the turn's `act.sub`
const PEER = randomUUID(); // another person on the pod
const SHARED = randomUUID(); // a space PERSON and PEER are both members of
const ELSEWHERE = randomUUID(); // another space of PERSON's
const FOREIGN = randomUUID(); // PEER's space; PERSON is not a member
const ROOM = randomUUID(); // S_PEER_ROOM's own minted room

const S_MINE = randomUUID(); // PERSON's session in SHARED: the run's own kind
const S_MINE_ELSEWHERE = randomUUID(); // PERSON's session in ELSEWHERE
const S_PEER = randomUUID(); // PEER's private session in SHARED
const S_PEER_ROOM = randomUUID(); // PEER's session in SHARED, PERSON seated
const S_FOREIGN = randomUUID(); // PEER's session in FOREIGN
const S_PEER_PERSONAL = randomUUID(); // PEER's pod-personal session

const q = (sql: string, params: unknown[] = []) => h.client!.query(sql, params);

const dir = mkdtempSync(path.join(tmpdir(), "run-read-floor-"));
const saved = {
  file: process.env.SYNAP_POD_IDENTITY_KEY_FILE,
  url: process.env.PUBLIC_URL,
};

beforeAll(async () => {
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const file = path.join(dir, "pod-key.pem");
  writeFileSync(
    file,
    privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    { mode: 0o600 }
  );
  process.env.SYNAP_POD_IDENTITY_KEY_FILE = file;
  process.env.PUBLIC_URL = "https://pod.lab1.synap.test";
  _resetPodIdentityForTest();
  h.knownOrigins.add(IS);

  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, user_type) values ($1,'p@x.test','human'),($2,'o@x.test','human')`,
    [PERSON, PEER]
  );
  await q(
    `insert into users (id, email, user_type, agent_type, created_by_user_id, is_personal_agent)
     values ($1,'house@synap.agent','agent','orchestrator',$2,true)`,
    [HOUSE, PERSON]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), PERSON, randomUUID(), PEER]
  );
  for (const [id, name, owner] of [
    [SHARED, "Shared", PERSON],
    [ELSEWHERE, "Elsewhere", PERSON],
    [FOREIGN, "Foreign", PEER],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [id, name, owner]
    );
  }
  for (const [ws, user, role] of [
    [SHARED, PERSON, "owner"],
    [SHARED, PEER, "editor"],
    [SHARED, HOUSE, "editor"],
    [ELSEWHERE, PERSON, "owner"],
    [FOREIGN, PEER, "owner"],
  ] as const) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,$4)`,
      [randomUUID(), ws, user, role]
    );
  }
  for (const [id, owner, ws, channelId] of [
    [S_MINE, PERSON, SHARED, null],
    [S_MINE_ELSEWHERE, PERSON, ELSEWHERE, null],
    [S_PEER, PEER, SHARED, null],
    [S_PEER_ROOM, PEER, SHARED, ROOM],
    [S_FOREIGN, PEER, FOREIGN, null],
    [S_PEER_PERSONAL, PEER, null, null],
  ] as const) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, channel_id, goal, status, criteria, stages, metadata, expected_outputs, started_at)
       values ($1,$2,$3,$4,'Ship it','active','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,'[]'::jsonb, now())`,
      [id, owner, ws, channelId]
    );
  }
  // S_PEER_ROOM's own room, as `ensureSessionChannel` mints it (the FK on the
  // session AND the stamp naming it), with PERSON seated as a human.
  await q(
    `insert into channels (id, user_id, workspace_id, context_object_type, context_object_id)
     values ($1,$2,$3,'focus_session',$4)`,
    [ROOM, PEER, SHARED, S_PEER_ROOM]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, role)
     values ($1,$2,$3,'human','owner'),($4,$2,$5,'human','member')`,
    [randomUUID(), ROOM, PEER, randomUUID(), PERSON]
  );
}, 120_000);

afterAll(() => {
  for (const [name, value] of [
    ["SYNAP_POD_IDENTITY_KEY_FILE", saved.file],
    ["PUBLIC_URL", saved.url],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _resetPodIdentityForTest();
});

beforeEach(() => {
  h.packet.mockReset();
  h.packet.mockResolvedValue({
    rerun: null,
    holder: null,
    evaluation: { status: "unavailable" },
    sentinel: "packet",
  });
  h.outcomes.mockReset();
  h.outcomes.mockResolvedValue({ status: "ok", sentinel: "outcomes" });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerFocusSessionsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

/** The run's turn as the pod signs it: PERSON, acting through their house agent. */
const runTurn = () =>
  mintIsDelegationToken({
    isUrl: IS,
    operatorUserId: PERSON,
    agentUserId: HOUSE,
    channelId: randomUUID(),
    runId: randomUUID(),
  });

type Body = Record<string, unknown> & { error?: string };

async function get(route: string) {
  const res = await app().request(`/api/hub${route}`, {
    headers: { authorization: `Bearer ${runTurn()}` },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body };
}

/** `get_session` as the IS sends it: the run's space as the lens. */
const getSession = (id: string, extra = "") =>
  get(`/focus-sessions/${id}?workspaceId=${SHARED}${extra}`);

/** `list_sessions` as the IS sends it. */
async function listSessions(workspaceId: string, extra = "") {
  const res = await get(
    `/focus-sessions?workspaceId=${workspaceId}&status=all&limit=50${extra}`
  );
  return {
    status: res.status,
    ids: Array.isArray(res.body)
      ? (res.body as Array<{ id: string }>).map((r) => r.id).sort()
      : res.body,
  };
}

describe("get_session in a run: the person's own sessions only", () => {
  it("reads the person's own session in the run's space, packet computed as that person", async () => {
    const res = await getSession(S_MINE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.id).toBe(S_MINE);
    expect(res.body.continuation).toMatchObject({ sentinel: "packet" });
    expect(h.packet).toHaveBeenCalledWith(
      expect.objectContaining({ id: S_MINE }),
      expect.objectContaining({ userId: PERSON })
    );
    expect(h.outcomes).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: S_MINE, userId: PERSON })
    );
  });

  it("another person's private session in a space both share: not found, no packet", async () => {
    const res = await getSession(S_PEER);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(h.packet).not.toHaveBeenCalled();
    expect(h.outcomes).not.toHaveBeenCalled();
  });

  it("another person's session whose room seats the person: not found on the run's door", async () => {
    // The fixture is a real seat: the HUMAN door's rule lets PERSON read it.
    expect(await sessionReaderIds(S_PEER_ROOM)).toEqual(
      expect.arrayContaining([PEER, PERSON])
    );
    const res = await getSession(S_PEER_ROOM);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(h.packet).not.toHaveBeenCalled();
  });

  it("a session in a space the person is not in: 403 with that lens, 404 without", async () => {
    const lensed = await get(
      `/focus-sessions/${S_FOREIGN}?workspaceId=${FOREIGN}`
    );
    expect(lensed.status, JSON.stringify(lensed.body)).toBe(403);
    for (const route of [
      `/focus-sessions/${S_FOREIGN}`,
      `/focus-sessions/${S_FOREIGN}?workspaceId=${SHARED}`,
    ]) {
      const res = await get(route);
      expect(res.status, `${route} ${JSON.stringify(res.body)}`).toBe(404);
    }
    expect(h.packet).not.toHaveBeenCalled();
  });

  it("another person's pod-personal session: not found", async () => {
    const res = await get(`/focus-sessions/${S_PEER_PERSONAL}`);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(h.packet).not.toHaveBeenCalled();
  });

  it("a ?userId naming another person is not honoured (is_internal may name users elsewhere)", async () => {
    for (const id of [S_PEER, S_PEER_ROOM]) {
      const res = await getSession(id, `&userId=${PEER}`);
      expect(res.status, `${id} ${JSON.stringify(res.body)}`).toBe(404);
    }
    const personal = await get(
      `/focus-sessions/${S_PEER_PERSONAL}?userId=${PEER}`
    );
    expect(personal.status).toBe(404);
    expect(h.packet).not.toHaveBeenCalled();
  });
});

describe("list_sessions in a run: the person's own sessions in the run's space", () => {
  it("lists exactly the person's own sessions in the run's space", async () => {
    const res = await listSessions(SHARED);
    expect(res.status, JSON.stringify(res.ids)).toBe(200);
    // Not S_PEER (private), not S_PEER_ROOM (seated: human doors only), not
    // S_MINE_ELSEWHERE (the lens narrows), not S_FOREIGN, not S_PEER_PERSONAL.
    expect(res.ids).toEqual([S_MINE]);
  });

  it("a ?userId naming another person changes nothing", async () => {
    const res = await listSessions(SHARED, `&userId=${PEER}`);
    expect(res.status, JSON.stringify(res.ids)).toBe(200);
    expect(res.ids).toEqual([S_MINE]);
  });

  it("a space the person is not in is refused, never listed", async () => {
    const res = await listSessions(FOREIGN);
    expect(res.status, JSON.stringify(res.ids)).toBe(403);
  });
});
