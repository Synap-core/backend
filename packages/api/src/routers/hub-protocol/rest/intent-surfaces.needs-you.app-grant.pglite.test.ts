/**
 * Hub `GET /needs-you` for a key bounded by a grant (a pod app's token): ONE
 * fetch of THE needs-you read, narrowed to what the grant reads, with the
 * pod's own folds and words.
 *
 * Driven through the REAL hub auth door (W1 fence + identity remap +
 * `runWithGrant`), the REAL route and the REAL needs-you read
 * (`signals.needsYou` → `readAttention`), compiled and run as SQL on PGlite.
 * Stubbed: the key lookup (`apiKeyService`), the guest check, and the review
 * half (`listSessionsAwaitingReview`, whose next-move facts PGlite cannot
 * build) — replaced by a read through the REAL session floor
 * (`sessionReadableWhere`, which ANDs the request's grant), so that half is
 * narrowed by the real predicate, not assumed.
 *
 * Fixtures: two spaces A and B, each with a session owing the person an ask,
 * a session awaiting review, a pending proposal and an unread notification.
 *
 * Rows rule out:
 *  - the fence admitting a key without `session.read` (would be 200);
 *  - the fence refusing a key that holds it, pinned to a space (was 403:
 *    `/needs-you` was unclassified, so no app could read it);
 *  - a key pinned to space A seeing ANY row of space B (asks, reviews,
 *    proposals) or the person's notifications (owner-floored, no grant
 *    clause): NEGATIVE CONTROL — with `needsYouWithheld` returning `[]` the
 *    notifications of both spaces come back to that key;
 *  - the proposals arriving without `proposal.read`, or staying away with it;
 *  - a named space dropping the key's proposal grant clause: `proposals.groups`
 *    replaced the floor with a bare workspace equality, so `?workspaceId=B`
 *    handed a proposal reader of A the proposals of B (found by this file's
 *    negative control; fixed in `buildProposalScopeConditions`);
 *  - REGRESSION: a full-access key reads exactly what the person reads
 *    (same count, same rows by fold), `withheld` absent.
 *
 * Cannot see: production Postgres; the real review half's SQL (stubbed, see
 * above; its floor is `sessionListConditions` → `sessionReadableWhere`).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

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
vi.mock("../../../services/projects/project-needs-you.js", async () => {
  const database = await import("@synap/database");
  const { sessionReadableWhere } =
    await import("../../../access/session-visibility.js");
  return {
    listSessionsAwaitingReview: async (q: {
      userId: string;
      workspaceId?: string | null;
    }) => {
      const fs = database.focusSessions;
      const rows = await (database.db as typeof database.db)
        .select({ id: fs.id, workspaceId: fs.workspaceId, title: fs.title })
        .from(fs)
        .where(
          database.and(
            // THE session floor: the owner, AND the request's grant.
            sessionReadableWhere({ userId: q.userId }),
            database.drizzleSql`${fs.metadata}->>'awaitingReview' = 'true'`,
            ...(typeof q.workspaceId === "string"
              ? [database.eq(fs.workspaceId, q.workspaceId)]
              : [])
          )
        );
      return {
        sessions: rows.map((r) => ({
          id: r.id,
          title: r.title ?? null,
          goal: null,
          updatedAt: new Date(),
          workspaceId: r.workspaceId ?? null,
          projectId: null,
          trackId: null,
        })),
        truncated: false,
      };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerIntentSurfacesRoutes } from "./intent-surfaces.js";
import { needsYouWithheld, signalsRouter } from "../../signals.js";
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
    const def = [
      "created_at",
      "updated_at",
      "timestamp",
      "started_at",
    ].includes(c.name)
      ? " default now()"
      : c.name === "is_active"
        ? " default true"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  const prefix = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${prefix}"${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // the person the app's key acts for
const AGENT = randomUUID(); // the key's principal, linked to OWNER
const WS_A = randomUUID();
const WS_B = randomUUID();
const ASK_A = randomUUID(); // a session of A owing the person an ask
const ASK_B = randomUUID();
const REVIEW_A = randomUUID(); // a session of A awaiting the person's review
const REVIEW_B = randomUUID();
const ENTITY_A = randomUUID();
const PROPOSAL_A = randomUUID();
const PROPOSAL_B = randomUUID();
const NOTE_A = "Heads up in space A";
const NOTE_B = "Heads up in space B";

/** Keys by bearer: each one's grant is a real `grants` row. */
const KEYS = {
  // Reads proposals and records in A, but not sessions: refused by the fence.
  noSession: {
    id: randomUUID(),
    permissions: ["proposal.read", "entity.read"],
    workspaceIds: [WS_A] as string[] | null,
  },
  // A pod app pinned to space A that reads sessions.
  appA: {
    id: randomUUID(),
    permissions: ["session.read"],
    workspaceIds: [WS_A] as string[] | null,
  },
  // The same app, also reading proposals.
  appAProposals: {
    id: randomUUID(),
    permissions: ["session.read", "proposal.read"],
    workspaceIds: [WS_A] as string[] | null,
  },
  // A person's unscoped key: full access, nothing narrowed.
  full: { id: randomUUID(), permissions: ["*"], workspaceIds: null },
} as const;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function session(o: {
  id: string;
  ws: string;
  owes?: boolean;
  review?: boolean;
}) {
  const slots = o.owes
    ? [
        {
          kind: "document",
          label: "Sign-off",
          status: "pending",
          owner: "human",
          blockedReason: "needs_human",
          owedSince: new Date().toISOString(),
        },
      ]
    : [];
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, origin, expected_outputs, metadata, criteria, created_at, started_at, updated_at)
     values ($1,$2,$3,'Ship it','active','human',$4::jsonb,$5::jsonb,'[]'::jsonb,now(),now(),now())`,
    [
      o.id,
      OWNER,
      o.ws,
      JSON.stringify(slots),
      JSON.stringify(o.review ? { awaitingReview: "true" } : {}),
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) {
    const cfg = getTableConfig(t);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t));
  }

  await q(
    `insert into users (id, name, email, user_type) values ($1,'Me','owner@example.test','human')`,
    [OWNER]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,'agent@example.test','agent',$2)`,
    [AGENT, OWNER]
  );
  for (const [ws, name] of [
    [WS_A, "Space A"],
    [WS_B, "Space B"],
  ]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await session({ id: ASK_A, ws: WS_A, owes: true });
  await session({ id: ASK_B, ws: WS_B, owes: true });
  await session({ id: REVIEW_A, ws: WS_A, review: true });
  await session({ id: REVIEW_B, ws: WS_B, review: true });
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties, created_at) values ($1,$2,$3,'note','Note','{}'::jsonb,now())`,
    [ENTITY_A, OWNER, WS_A]
  );
  // Two shapes, so the two spaces' proposals never fold into one cluster.
  await q(
    `insert into proposals (id, created_by, workspace_id, proposal_type, target_type, target_id, data, status, created_at, updated_at)
     values ($1,$2,$3,'update','entity',$4,'{}'::jsonb,'pending',now(),now())`,
    [PROPOSAL_A, OWNER, WS_A, ENTITY_A]
  );
  await q(
    `insert into proposals (id, created_by, workspace_id, proposal_type, target_type, target_id, data, status, created_at, updated_at)
     values ($1,$2,$3,'create','entity',null,$4::jsonb,'pending',now(),now())`,
    [PROPOSAL_B, OWNER, WS_B, JSON.stringify({ profileSlug: "note" })]
  );
  for (const [ws, title] of [
    [WS_A, NOTE_A],
    [WS_B, NOTE_B],
  ])
    await q(
      `insert into notifications (id, user_id, workspace_id, type, category, title, status, created_at) values (gen_random_uuid(),$1,$2,'custom.note','inbox',$3,'unread',now())`,
      [OWNER, ws, title]
    );
  for (const k of Object.values(KEYS)) {
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        AGENT,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
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
        userId: AGENT,
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
  registerIntentSurfacesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

interface NeedsYouBody {
  lens?: string;
  count?: Record<string, unknown>;
  rows?: Record<string, Array<{ id: string; kind: string }>>;
  truncated?: boolean;
  withheld?: string[];
  error?: string;
  code?: string;
}

async function needsYou(key: KeyName, query = "") {
  const res = await app().request(`/api/hub/needs-you${query}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });
  const body = (await res.json()) as NeedsYouBody;
  return { status: res.status, body, text: JSON.stringify(body) };
}

const rowsOf = (b: NeedsYouBody) => Object.values(b.rows ?? {}).flat();
const idsByFold = (b: NeedsYouBody) =>
  Object.fromEntries(
    Object.entries(b.rows ?? {}).map(([fold, list]) => [
      fold,
      list.map((r) => r.id).sort(),
    ])
  );

describe("GET /needs-you — a key bounded by a grant", () => {
  it("a key without session.read is refused by the fence", async () => {
    const { status, body } = await needsYou("noSession");
    expect(status, JSON.stringify(body)).toBe(403);
    expect(body.code).toBe("GRANT_DOOR_UNSUPPORTED");
  });

  it("a key pinned to space A reads A's asks and reviews, never B's, and no notification", async () => {
    const { status, body, text } = await needsYou("appA");
    expect(status, text).toBe(200);
    expect(body.lens).toBe("needs-you");
    // Non-vacuity: A's rows arrive, in the pod's own folds.
    expect(text).toContain(ASK_A);
    expect(text).toContain(REVIEW_A);
    expect(Object.keys(body.rows ?? {}).sort()).toEqual(
      [
        "needs_you",
        "working",
        "stopped",
        "review_later",
        "from_system",
        "changes_to_review",
      ].sort()
    );
    // Nothing of space B, and none of the person's notifications.
    for (const id of [ASK_B, REVIEW_B, PROPOSAL_A, PROPOSAL_B])
      expect(text).not.toContain(id);
    expect(text).not.toContain(NOTE_A);
    expect(text).not.toContain(NOTE_B);
    expect(rowsOf(body).map((r) => r.kind)).not.toContain("notification");
    // The count is over the same narrowed read.
    expect(body.count?.notifications).toBe(0);
    expect(body.count?.captures).toBe(0);
    // Said, never an empty fold: what the key did not read.
    expect(body.withheld).toEqual(
      expect.arrayContaining(["proposals", "notifications", "captures"])
    );
    expect(body.withheld ?? []).not.toContain("owed");
    expect(body.withheld ?? []).not.toContain("review");
  });

  it("naming space B gives that key nothing of B (the grant bounds the lens)", async () => {
    const { status, text } = await needsYou("appA", `?workspaceId=${WS_B}`);
    expect(status, text).toBe(200);
    for (const id of [ASK_B, REVIEW_B, PROPOSAL_B])
      expect(text).not.toContain(id);
  });

  it("the proposals arrive only with proposal.read, and only A's", async () => {
    const { status, body, text } = await needsYou("appAProposals");
    expect(status, text).toBe(200);
    expect(text).toContain(PROPOSAL_A);
    expect(text).not.toContain(PROPOSAL_B);
    expect(text).not.toContain(ASK_B);
    expect(body.withheld ?? []).not.toContain("proposals");
    expect(body.withheld).toContain("notifications");
  });

  it("naming space B gives a proposal reader of A none of B's proposals (the lens keeps the grant clause)", async () => {
    // `proposals.groups` under a named space replaced the floor with a bare
    // workspace equality and dropped the key's grant clause: B's proposal
    // came back to a key that reads proposals in A only.
    const { status, text } = await needsYou(
      "appAProposals",
      `?workspaceId=${WS_B}`
    );
    expect(status, text).toBe(200);
    for (const id of [PROPOSAL_B, ASK_B, REVIEW_B])
      expect(text).not.toContain(id);
    // Control: naming A keeps A's proposal.
    const own = await needsYou("appAProposals", `?workspaceId=${WS_A}`);
    expect(own.text).toContain(PROPOSAL_A);
  });

  it("REGRESSION: a full-access key reads exactly what the person reads, nothing withheld", async () => {
    const { status, body, text } = await needsYou("full");
    expect(status, text).toBe(200);
    expect(body.withheld).toBeUndefined();
    // Non-vacuity of the fixtures: both spaces, the proposals and the
    // notifications are in the whole read.
    for (const id of [ASK_A, ASK_B, REVIEW_A, REVIEW_B, PROPOSAL_A, PROPOSAL_B])
      expect(text).toContain(id);
    expect(body.count?.notifications).toBe(2);
    // The person's own read (no grant at all): the same answer.
    const person = await signalsRouter
      .createCaller({
        db: null,
        authenticated: true,
        userId: OWNER,
        workspaceId: null,
        isHubProtocol: true,
      } as never)
      .needsYou({ limit: 100 });
    expect(person.withheld).toBeUndefined();
    expect(body.count).toEqual(JSON.parse(JSON.stringify(person.count)));
    expect(idsByFold(body)).toEqual(
      idsByFold(JSON.parse(JSON.stringify(person)) as NeedsYouBody)
    );
  });
});

describe("needsYouWithheld — the rule, per key", () => {
  const grant = (permissions: string[], workspaceIds?: string[]) =>
    ({
      scopes: [{ permissions, ...(workspaceIds ? { workspaceIds } : {}) }],
      clientId: null,
    }) as never;
  const PERSON_LEVEL = [
    "notifications",
    "captures",
    "issuers",
    "app-requests",
    "key-requests",
    "broken-connections",
    "invites",
    "convertible-goals",
  ];
  it("a pinned session reader: proposals and every person-level half withheld", () => {
    expect(needsYouWithheld(grant(["session.read"], [WS_A])).sort()).toEqual(
      ["proposals", ...PERSON_LEVEL].sort()
    );
  });
  it("with proposal.read the proposals are read (through their grant clause)", () => {
    expect(
      needsYouWithheld(grant(["session.read", "proposal.read"], [WS_A])).sort()
    ).toEqual([...PERSON_LEVEL].sort());
  });
  it("CONTROL: a person, a full key and an unbounded reader of every subject withhold nothing", () => {
    expect(needsYouWithheld(null)).toEqual([]);
    expect(needsYouWithheld(grant(["*"]))).toEqual([]);
    expect(
      needsYouWithheld(
        grant(["session.read", "proposal.read", "channel.read", "entity.read"])
      )
    ).toEqual([]);
  });
});
