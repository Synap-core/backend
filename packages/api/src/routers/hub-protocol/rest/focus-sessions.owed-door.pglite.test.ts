/**
 * GET /focus-sessions/owed — "what waits on you", the ONE needs-you owed
 * predicate (`listNeedsYouOwed`) served to a SCOPED key, so a pod app pinned
 * to one space (Content Studio) reads the pod's own answer instead of
 * re-deriving it from a capped page of sessions.
 *
 * Driven through the REAL hub auth door (W1 fence + `runWithGrant`), the REAL
 * route and the REAL SQL on PGlite. Stubbed: the key lookup, the guest check.
 *
 * Rows rule out:
 *  - the fence refusing the door for a space-pinned key (403
 *    GRANT_DOOR_UNSUPPORTED), or the `:id` route swallowing `/owed`;
 *  - a pinned key reading another space's asks (the owner floor without the
 *    grant: `sessionReadableWhere` dropped from `listOwedSlots`);
 *  - a second predicate: an answered (handed-back), done or retired slot
 *    listed; a slot on a CLOSED session dropped (a slot outlives its session);
 *    a draft's ask-less slot listed, or its ask dropped; another person's
 *    session listed;
 *  - the subject lens not narrowing, or a slot arriving without the thing it
 *    is about (`subjectEntityId`) or the agent who asks (`agentName`).
 *
 * Cannot see: production Postgres; the pod app's own rendering.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getApiKeyStatus: vi.fn(),
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
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => h.getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
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
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "started_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // the person the pod app acts for
const PRINCIPAL = randomUUID(); // the key principal, linked to OWNER
const OTHER = randomUUID(); // another person on the pod
const WRITER = randomUUID(); // the agent working the posts
const WS = randomUUID(); // the space the pod app was granted
const WS2 = randomUUID(); // a space it was not
const POST_PROFILE = randomUUID();
const POST1 = randomUUID();
const POST2 = randomUUID();
const POST_ELSEWHERE = randomUUID();

const S_ASK = randomUUID(); // open, accepted: one owed ask + slots that are not owed
const S_CLOSED = randomUUID(); // closed, still owes one
const S_DRAFT = randomUUID(); // an undecided agent draft: one ask, one ask-less slot
const S_ELSEWHERE = randomUUID(); // the owner's, in the space NOT granted
const S_OTHER = randomUUID(); // another person's session in the granted space

const OWED = (label: string, owedSince: string, extra = {}) => ({
  kind: "decision",
  label,
  owner: "human",
  blockedReason: "decision",
  owedSince,
  ...extra,
});
const CHOOSE = {
  mode: "choose",
  options: [
    { label: "Approve the script", recommended: true },
    { label: "Rework the script" },
  ],
};

const KEYS = {
  // A pod app's consent: read sessions, in ONE space (fenced and pinned).
  podApp: { id: randomUUID(), permissions: ["session.read"], ws: [WS] },
  // The same permission, no space: it reads the owner's asks everywhere.
  wide: { id: randomUUID(), permissions: ["session.read"], ws: null },
  // A key that cannot read sessions at all.
  docOnly: { id: randomUUID(), permissions: ["document.read"], ws: null },
} as const;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(p: {
  id: string;
  userId: string;
  workspaceId: string;
  subject: string | null;
  status: string;
  origin: string;
  accepted: boolean;
  agents: string[];
  outputs: unknown[];
}) {
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, subject_entity_id, goal, title, status, origin, agent_ids, criteria, metadata, expected_outputs)
     values ($1,$2,$3,$4,'Produce the post','Produce the post',$5,$6,$7::text[],'[]'::jsonb,$8::jsonb,$9::jsonb)`,
    [
      p.id,
      p.userId,
      p.workspaceId,
      p.subject,
      p.status,
      p.origin,
      `{${p.agents.join(",")}}`,
      JSON.stringify(
        p.accepted ? { triage: { acceptedAt: "2026-10-01T00:00:00.000Z" } } : {}
      ),
      JSON.stringify(p.outputs),
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, user_type) values ($1,'owner@example.test','human'), ($2,'other@example.test','human')`,
    [OWNER, OTHER]
  );
  await q(
    `insert into users (id, email, name, user_type, created_by_user_id) values
       ($1,'principal@example.test','App key','agent',$3),
       ($2,'writer@example.test','Content writer','agent',$3)`,
    [PRINCIPAL, WRITER, OWNER]
  );
  for (const ws of [WS, WS2]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, ws === WS ? "Content OS" : "Builder", OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'member')`,
    [randomUUID(), WS, OTHER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'post','Post','kind','system','workspace',true,'{}'::jsonb,null)`,
    [POST_PROFILE]
  );
  for (const [id, ws] of [
    [POST1, WS],
    [POST2, WS],
    [POST_ELSEWHERE, WS2],
  ]) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'post','A post','{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, ws, POST_PROFILE]
    );
  }

  await session({
    id: S_ASK,
    userId: OWNER,
    workspaceId: WS,
    subject: POST1,
    status: "active",
    origin: "playbook",
    accepted: true,
    agents: [WRITER],
    outputs: [
      OWED("Approve the script", "2026-10-13T18:24:48.055Z", {
        why: "The draft waits on the script.",
        ask: CHOOSE,
      }),
      // Answered: the pod handed it back to the agent (owner cleared).
      { kind: "playbook_param", label: "Answer: Post" },
      // Done, retired, optional: none of them is owed.
      OWED("Delivered", "2026-10-02T00:00:00.000Z", { status: "done" }),
      OWED("Retired", "2026-10-02T00:00:00.000Z", {
        retiredAt: "2026-10-03T00:00:00.000Z",
      }),
      OWED("Optional", "2026-10-02T00:00:00.000Z", { optional: true }),
    ],
  });
  await session({
    id: S_CLOSED,
    userId: OWNER,
    workspaceId: WS,
    subject: POST2,
    status: "closed",
    origin: "human",
    accepted: false,
    agents: [],
    outputs: [OWED("Pick the cover", "2026-10-01T09:00:00.000Z")],
  });
  await session({
    id: S_DRAFT,
    userId: OWNER,
    workspaceId: WS,
    subject: POST2,
    status: "active",
    origin: "agent",
    accepted: false,
    agents: [WRITER],
    outputs: [
      // Not an ask: a deliverable only the person can make (a `decision` blocker
      // would derive a confirm ask, `effectiveSlotAsk`, and count on a draft).
      OWED("Draft deliverable", "2026-10-20T00:00:00.000Z", {
        kind: "document",
        blockedReason: "physical",
      }),
      OWED("Which hook?", "2026-10-21T00:00:00.000Z", { ask: CHOOSE }),
    ],
  });
  await session({
    id: S_ELSEWHERE,
    userId: OWNER,
    workspaceId: WS2,
    subject: POST_ELSEWHERE,
    status: "active",
    origin: "human",
    accepted: false,
    agents: [],
    outputs: [OWED("Not this space's", "2026-10-05T00:00:00.000Z")],
  });
  await session({
    id: S_OTHER,
    userId: OTHER,
    workspaceId: WS,
    subject: POST1,
    status: "active",
    origin: "human",
    accepted: false,
    agents: [],
    outputs: [OWED("Someone else's", "2026-10-04T00:00:00.000Z")],
  });

  for (const k of Object.values(KEYS)) {
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        PRINCIPAL,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.ws ? `{${k.ws.join(",")}}` : null,
      ]
    );
  }
}, 120_000);

beforeEach(() => {
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const name = bearer.replace(/^synap_/, "") as KeyName;
    return {
      status: "valid",
      record: {
        id: KEYS[name].id,
        userId: PRINCIPAL,
        linkedUserId: OWNER,
        parentKeyId: null,
        scope: ["hub-protocol.read"],
        keyType: "hub_inbound",
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerFocusSessionsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

type Slot = {
  sessionId: string;
  label: string;
  subjectEntityId: string | null;
  agentName: string | null;
  sessionStatus: string;
  ask?: { mode: string; options?: Array<{ label: string }> };
  why?: string;
  owedSince: string;
};
type Body = {
  slots?: Slot[];
  truncated?: boolean;
  error?: string;
  code?: string;
};

async function owed(key: KeyName, query = "") {
  const res = await app().request(`/api/hub/focus-sessions/owed${query}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const labels = (b: Body) => (b.slots ?? []).map((s) => s.label);

describe("GET /focus-sessions/owed — what waits on you, for a scoped key", () => {
  it("a pod app pinned to its space reads that space's asks, by the pod's own predicate", async () => {
    const { status, body } = await owed("podApp");
    expect(status, JSON.stringify(body)).toBe(200);
    // Oldest first. The closed session's slot is still owed; the draft shows
    // its ask only; answered, done, retired and optional slots are not owed.
    expect(labels(body)).toEqual([
      "Pick the cover",
      "Approve the script",
      "Which hook?",
    ]);
    expect(body.truncated).toBe(false);
  });

  it("the grant bounds it: another space's ask is out for the pinned key, in for a wide one", async () => {
    expect(labels((await owed("podApp")).body)).not.toContain(
      "Not this space's"
    );
    expect(labels((await owed("wide")).body)).toContain("Not this space's");
  });

  it("never another person's session, whatever the key", async () => {
    for (const key of ["podApp", "wide"] as const) {
      expect(labels((await owed(key)).body)).not.toContain("Someone else's");
    }
  });

  it("each slot names the thing it is about, the agent who asks, and how to answer", async () => {
    const { body } = await owed("podApp");
    const ask = body.slots!.find((s) => s.label === "Approve the script")!;
    expect(ask).toMatchObject({
      sessionId: S_ASK,
      subjectEntityId: POST1,
      agentName: "Content writer",
      sessionStatus: "active",
      why: "The draft waits on the script.",
      owedSince: "2026-10-13T18:24:48.055Z",
    });
    expect(ask.ask?.mode).toBe("choose");
    const closed = body.slots!.find((s) => s.label === "Pick the cover")!;
    expect(closed).toMatchObject({
      subjectEntityId: POST2,
      agentName: null,
      sessionStatus: "closed",
    });
  });

  it("the subject lens narrows to one thing, or to every thing of a kind", async () => {
    const one = await owed("podApp", `?subjectEntityId=${POST1}`);
    expect(one.status).toBe(200);
    expect(labels(one.body)).toEqual(["Approve the script"]);
    const kind = await owed(
      "podApp",
      `?workspaceId=${WS}&subjectProfileSlug=post`
    );
    expect(kind.status, JSON.stringify(kind.body)).toBe(200);
    expect(labels(kind.body)).toEqual([
      "Pick the cover",
      "Approve the script",
      "Which hook?",
    ]);
    const unknown = await owed("podApp", "?subjectProfileSlug=nope");
    expect(unknown.status).toBe(404);
  });

  it("limit caps the page and says so", async () => {
    const { body } = await owed("podApp", "?limit=2");
    expect(labels(body)).toEqual(["Pick the cover", "Approve the script"]);
    expect(body.truncated).toBe(true);
  });

  it("a key that cannot read sessions reads none (fenced in, floored by its grant)", async () => {
    const { status, body } = await owed("docOnly");
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.slots).toEqual([]);
  });
});
