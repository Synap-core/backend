/**
 * A SCOPED agent key reads the session it works on over Hub REST, as it
 * already can over MCP (`synap_get_session`) — and names its own agent
 * principal without flooring as the agent.
 *
 * Driven through the REAL hub auth door (W1 fence + identity remap +
 * `runWithGrant`), the REAL routes and the REAL floors, compiled and run as SQL
 * on PGlite. Stubbed: the key lookup (`apiKeyService`), the guest check, and
 * the two session projections (`projectContinuationPacket`,
 * `readSessionOutcomesSection`) — they are not under test; a sentinel proves
 * the route reached them for THIS session and THIS acting user.
 *
 * Rows rule out:
 *  - the fence still refusing the session doors for a key whose grant reads
 *    every subject they declare (would be 403 GRANT_DOOR_UNSUPPORTED);
 *  - the fence admitting a key that lacks a declared subject, or is pinned to
 *    a space (would be 200) — `sessionAndRoom` passes `/answers` (it declares
 *    session + channel) yet is refused on `/:id` (it declares more): the
 *    declaration is per route, not one blanket "session" switch;
 *  - the declaration widening WHOSE rows a key reads: another person's
 *    session stays 404 (an agent reading another person's session is a
 *    separate founder decision, not this door);
 *  - `?userId=<own agent principal>` flooring as the agent (the entity would
 *    be 404) or being refused; a foreign `?userId` being honoured.
 *
 * Cannot see: production Postgres; whether a declared subject list is
 * complete for its door (a review question — `grant-door-fence.ts`).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getApiKeyStatus: vi.fn(),
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
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerFocusSessionsRoutes } from "./focus-sessions.js";
import { registerEntitiesRoutes } from "./entities.js";
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

const OWNER = randomUUID(); // the human the agent key acts for
const AGENT = randomUUID(); // the key principal (an agent user, linked to OWNER)
const OTHER = randomUUID(); // another person on the pod
const WS = randomUUID();
const NOTE_PROFILE = randomUUID();
const S_OWN = randomUUID(); // OWNER's session — the one the agent works on
const S_OTHER = randomUUID(); // OTHER's session
const E_PERSONAL = randomUUID(); // OWNER's pod-personal entity (no workspace)

const AI_PERMISSIONS = GRANT_PRESETS.find(
  (r) => r.id === AI_READ_PROPOSE_ROLE_ID
)!.grant.permissions;

/** Keys by bearer: each one's grant is a real `grants` row. */
const KEYS = {
  // The "AI read and propose" preset, unnarrowed — the device-flow default.
  ai: { id: randomUUID(), permissions: AI_PERMISSIONS, workspaceIds: null },
  // The same preset pinned to one space: a declared door cannot narrow to it.
  aiPinned: {
    id: randomUUID(),
    permissions: AI_PERMISSIONS,
    workspaceIds: [WS] as string[] | null,
  },
  // Reads the session and its room only: enough for /answers, not for /:id.
  sessionAndRoom: {
    id: randomUUID(),
    permissions: ["session.read", "channel.read"],
    workspaceIds: null,
  },
  docOnly: {
    id: randomUUID(),
    permissions: ["document.read"],
    workspaceIds: null,
  },
} as const;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const [id, email] of [
    [OWNER, "owner@example.test"],
    [OTHER, "other@example.test"],
  ]) {
    await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
      id,
      email,
    ]);
  }
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "agent@example.test", OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Space',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
  for (const [id, userId] of [
    [S_OWN, OWNER],
    [S_OTHER, OTHER],
  ]) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status, criteria, metadata, expected_outputs)
       values ($1,$2,null,'Ship it','active','[]'::jsonb,'{}'::jsonb,'[]'::jsonb)`,
      [id, userId]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'note','Note','kind','system','pod',true,'{}'::jsonb,null)`,
    [NOTE_PROFILE]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
     values ($1,$2,null,$3,'note','Owner note','{}'::jsonb,'{}'::jsonb)`,
    [E_PERSONAL, OWNER, NOTE_PROFILE]
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
  h.packet.mockReset();
  h.packet.mockResolvedValue({
    rerun: null,
    evaluation: { status: "unavailable" },
    sentinel: "packet",
  });
  h.outcomes.mockReset();
  h.outcomes.mockResolvedValue({ status: "ok", sentinel: "outcomes" });
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
  registerFocusSessionsRoutes(hub);
  registerEntitiesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const get = (key: KeyName, path: string) =>
  app().request(`/api/hub${path}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });

type Body = Record<string, unknown> & { error?: string; code?: string };

describe("GET /focus-sessions/:id (+ evaluations, answers) — a scoped agent key", () => {
  it("(a) a key whose grant reads every declared subject reads its human's session", async () => {
    const res = await get("ai", `/focus-sessions/${S_OWN}`);
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.id).toBe(S_OWN);
    // The projections ARRIVE, computed for this session as the linked human.
    expect(body.outcomes).toMatchObject({ sentinel: "outcomes" });
    expect(h.outcomes).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: S_OWN, userId: OWNER })
    );
    expect(h.packet).toHaveBeenCalledWith(
      expect.objectContaining({ id: S_OWN }),
      expect.objectContaining({ userId: OWNER })
    );
  });

  it("(a) the same key reads the session's evaluations and answers", async () => {
    const ev = await get("ai", `/focus-sessions/${S_OWN}/evaluations`);
    const evBody = (await ev.json()) as Body;
    expect(ev.status, JSON.stringify(evBody)).toBe(200);
    expect(evBody.history).toEqual([]);

    const an = await get("ai", `/focus-sessions/${S_OWN}/answers`);
    const anBody = (await an.json()) as Body;
    expect(an.status, JSON.stringify(anBody)).toBe(200);
    expect(anBody.answers).toEqual([]);
  });

  it("(b) a key that lacks a declared subject is refused by the fence (fail closed)", async () => {
    for (const path of [
      `/focus-sessions/${S_OWN}`,
      `/focus-sessions/${S_OWN}/evaluations`,
      `/focus-sessions/${S_OWN}/answers`,
    ]) {
      const res = await get("docOnly", path);
      const body = (await res.json()) as Body;
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(403);
      expect(body.code).toBe("GRANT_DOOR_UNSUPPORTED");
    }
    expect(h.packet).not.toHaveBeenCalled();
  });

  it("(b) a key pinned to a space is refused: a declared door cannot narrow to it", async () => {
    const res = await get("aiPinned", `/focus-sessions/${S_OWN}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as Body).code).toBe("GRANT_DOOR_UNSUPPORTED");
  });

  it("(b) the declaration is per route: session+room reads /answers, not the full packet", async () => {
    const an = await get("sessionAndRoom", `/focus-sessions/${S_OWN}/answers`);
    expect(an.status, JSON.stringify(await an.clone().json())).toBe(200);
    const full = await get("sessionAndRoom", `/focus-sessions/${S_OWN}`);
    expect(full.status).toBe(403);
    expect(((await full.json()) as Body).code).toBe("GRANT_DOOR_UNSUPPORTED");
  });

  it("another person's session stays not found: the grant bounds subjects, never owners", async () => {
    const res = await get("ai", `/focus-sessions/${S_OTHER}`);
    expect(res.status).toBe(404);
    expect(h.packet).not.toHaveBeenCalled();
    expect((await get("ai", `/focus-sessions/${S_OTHER}/answers`)).status).toBe(
      404
    );
  });
});

describe("GET /entities/:id?userId= — the key's own agent principal acts as its linked human", () => {
  it("(c) ?userId=<own agent principal> reads the linked human's pod-personal entity", async () => {
    const res = await get("ai", `/entities/${E_PERSONAL}?userId=${AGENT}`);
    const body = (await res.json().catch(() => null)) as Body | null;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body?.id).toBe(E_PERSONAL);
  });

  it("control: naming the linked human, or nobody, reads the same entity", async () => {
    expect(
      (await get("ai", `/entities/${E_PERSONAL}?userId=${OWNER}`)).status
    ).toBe(200);
    expect((await get("ai", `/entities/${E_PERSONAL}`)).status).toBe(200);
  });

  it("(d) any other ?userId stays refused", async () => {
    for (const other of [OTHER, randomUUID()]) {
      const res = await get("ai", `/entities/${E_PERSONAL}?userId=${other}`);
      expect(res.status).toBe(403);
      expect(((await res.json()) as Body).error).toBe(
        "userId does not match the authenticated session"
      );
    }
  });
});
