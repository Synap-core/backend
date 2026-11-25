/**
 * An AI-service turn may write AS the agent the pod signed for it — at the two
 * doors an approved playbook run writes through.
 *
 * LIVE 2026-11-09 (pod antoinesrvt): an external agent (Claude Code) launched
 * "Make a brand asset" runs; they came back as proposals; the person approved
 * them. Each run's turn went to the AI service as the person (`sub`) with the
 * person's house agent as its acting agent (`act.sub`, picked by
 * `resolveIntelligenceService`), and the IS named that agent on every write.
 * `resolveActorId` only accepted an agent an `api_keys` row links to the
 * caller, and a house agent holds no key, so every `create_document` (with
 * `entityId`) and `update_entity` came back 400 "Not authorized to act as this
 * agentUserId". (Capture never reads a body agent, so it went through.)
 *
 * Driven through the REAL hub auth door with a REAL pod-signed delegation
 * (`mintIsDelegationToken`, a real key file), the REAL routes and the REAL
 * `resolveActorId` SQL on PGlite. Stubbed past the act-as gate: the governed
 * tRPC caller (`getCaller`) and the body attach/preflight, which record what
 * reached them. Pins:
 *   - the run's writes reach the governed doors, attributed to the house agent;
 *   - the IDOR floor holds: a different agent than the one signed, an unsigned
 *     turn (no `act.sub`), and an agent key naming the house agent all stay 400.
 * Cannot see: the IS itself, production Postgres, the governance verdict.
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
  getApiKeyStatus: vi.fn(),
  reached: [] as Array<{ door: string; input: Record<string, unknown> }>,
  knownOrigins: new Set<string>(),
  noopEvents: () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? undefined
            : async () => ({ id: globalThis.crypto.randomUUID() }),
      }
    ),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: h.noopEvents(),
    EventRepository: class {
      constructor() {
        return h.noopEvents();
      }
    },
  };
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
// Past the act-as gate: the governed caller records what reached it.
vi.mock("./_shared.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCaller: async () => ({
    documents: {
      createDocument: async (input: Record<string, unknown>) => {
        h.reached.push({ door: "createDocument", input });
        return { status: "created", id: DOC, documentId: DOC };
      },
    },
    entities: {
      updateEntity: async (input: Record<string, unknown>) => {
        h.reached.push({ door: "updateEntity", input });
        return { status: "updated", entityId: input.entityId };
      },
    },
  }),
}));
vi.mock("../../../services/entity-body/body-replace-guard.js", async (io) => ({
  ...(await io<Record<string, unknown>>()),
  preflightAttachToEntity: async (input: { entityId: string }) => ({
    id: input.entityId,
    workspaceId: BRAND,
    homeWorkspaceId: null,
  }),
}));
vi.mock("../attach-created-document.js", () => ({
  attachCreatedDocument: async (input: Record<string, unknown>) => {
    h.reached.push({ door: "attachCreatedDocument", input });
    return input.created;
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  _resetPodIdentityForTest,
  mintIsDelegationToken,
} from "@synap/database";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerDocumentsRoutes } from "./documents.js";
import { registerEntitiesRoutes } from "./entities.js";
import type { HubHono, HubVariables } from "./_shared.js";

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
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const IS = "https://intelligence.synap.test";
const PERSON = randomUUID(); // approved the run; the turn's operator (`sub`)
const HOUSE = randomUUID(); // the person's house agent: the turn's `act.sub`
const LAUNCHER = randomUUID(); // the external agent that launched the run
const LAUNCHER_KEY = randomUUID(); // its key, linked to the person
const OTHER_PERSON = randomUUID();
const OTHER_AGENT = randomUUID(); // someone else's agent, linked to them
const BRAND = randomUUID();
const ASSET = randomUUID(); // the brand asset the run writes to
const DOC = randomUUID();

const q = (sql: string, params: unknown[] = []) => h.client!.query(sql, params);

const dir = mkdtempSync(path.join(tmpdir(), "is-turn-act-as-"));
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
    [PERSON, OTHER_PERSON]
  );
  // The house agent as `ensurePersonalAgentUser` makes it: no key of its own.
  await q(
    `insert into users (id, email, user_type, agent_type, created_by_user_id, is_personal_agent)
     values ($1,'house@synap.agent','agent','orchestrator',$2,true)`,
    [HOUSE, PERSON]
  );
  await q(
    `insert into users (id, email, user_type, agent_type, created_by_user_id)
     values ($1,'cc@x.test','agent','claude-code',$2),($3,'oa@x.test','agent','claude-code',$4)`,
    [LAUNCHER, PERSON, OTHER_AGENT, OTHER_PERSON]
  );
  await q(
    `insert into api_keys (id, user_id, linked_user_id, key_type, is_active)
     values ($1,$2,$3,'hub_inbound',true),($4,$5,$6,'hub_inbound',true)`,
    [LAUNCHER_KEY, LAUNCHER, PERSON, randomUUID(), OTHER_AGENT, OTHER_PERSON]
  );
  // The launcher's key carries the explicit full access a connected agent's
  // key gets (deny by default otherwise).
  await q(
    `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, created_by)
     values ($1,$2,$3,$4,'{*}'::text[],$4)`,
    [randomUUID(), LAUNCHER_KEY, LAUNCHER, PERSON]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), PERSON]
  );
  await q(
    `insert into workspaces (id, name, owner_id) values ($1,'Brand',$2)`,
    [BRAND, PERSON]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ($1,$2,$3,'owner'),($4,$2,$5,'editor')`,
    [randomUUID(), BRAND, PERSON, randomUUID(), HOUSE]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, title, type)
     values ($1,$2,$3,'Template · Hook cover slide','brand-asset')`,
    [ASSET, PERSON, BRAND]
  );
});

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
  h.reached.length = 0;
  h.getApiKeyStatus.mockReset();
  h.getApiKeyStatus.mockImplementation(async () => ({
    status: "valid",
    record: {
      id: LAUNCHER_KEY,
      userId: LAUNCHER,
      linkedUserId: PERSON,
      parentKeyId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      keyType: "hub_inbound",
      workspaceId: null,
      expiresAt: null,
    },
  }));
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerDocumentsRoutes(hub);
  registerEntitiesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

/** The run's turn as the pod signs it: the person, acting through `actAs`. */
const turnToken = (actAs: string | null) =>
  mintIsDelegationToken({
    isUrl: IS,
    operatorUserId: PERSON,
    agentUserId: actAs,
    channelId: randomUUID(),
  });

async function send(
  bearer: string,
  method: "POST" | "PATCH",
  route: string,
  body: Record<string, unknown>
) {
  const json = JSON.stringify(body);
  const res = await app().request(`/api/hub${route}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
    },
    body: json,
  });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** The two writes the brand-asset run made, as the IS sends them. */
const createBody = (agentUserId: string) => ({
  userId: PERSON,
  agentUserId,
  entityId: ASSET,
  title: "Hook cover slide — draft",
  content: "<section>4:5</section><section>16:9</section>",
});
const updateBody = (agentUserId: string) => ({
  userId: PERSON,
  agentUserId,
  metadata: { generator: "hand-authored HTML/CSS" },
  reasoning: "Record the draft's provenance",
});

const ACT_AS_REFUSED = /Not authorized to act as this agentUserId/;

describe("an approved run's turn writes as the agent the pod signed for it", () => {
  it("create_document with entityId reaches the governed door, as the house agent", async () => {
    const res = await send(
      turnToken(HOUSE),
      "POST",
      "/documents",
      createBody(HOUSE)
    );
    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(h.reached.map((r) => r.door)).toEqual([
      "createDocument",
      "attachCreatedDocument",
    ]);
    expect(h.reached[0]!.input).toMatchObject({
      userId: PERSON,
      agentUserId: HOUSE,
    });
    expect(h.reached[1]!.input).toMatchObject({
      entityId: ASSET,
      agentUserId: HOUSE,
    });
  });

  it("update_entity reaches the governed door, as the house agent", async () => {
    const res = await send(
      turnToken(HOUSE),
      "PATCH",
      `/entities/${ASSET}`,
      updateBody(HOUSE)
    );
    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(h.reached).toHaveLength(1);
    expect(h.reached[0]!.input).toMatchObject({
      entityId: ASSET,
      userId: PERSON,
      agentUserId: HOUSE,
    });
  });
});

describe("the act-as floor still refuses every agent the pod did not sign", () => {
  it("a turn signed for the house agent cannot name another person's agent", async () => {
    for (const [method, route, body] of [
      ["POST", "/documents", createBody(OTHER_AGENT)],
      ["PATCH", `/entities/${ASSET}`, updateBody(OTHER_AGENT)],
    ] as const) {
      const res = await send(turnToken(HOUSE), method, route, body);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(ACT_AS_REFUSED);
    }
    expect(h.reached).toEqual([]);
  });

  it("a turn the pod signed for NO agent cannot name the house agent", async () => {
    for (const [method, route, body] of [
      ["POST", "/documents", createBody(HOUSE)],
      ["PATCH", `/entities/${ASSET}`, updateBody(HOUSE)],
    ] as const) {
      const res = await send(turnToken(null), method, route, body);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(ACT_AS_REFUSED);
    }
    expect(h.reached).toEqual([]);
  });

  it("the launching agent's own key cannot borrow the house agent", async () => {
    for (const [method, route, body] of [
      ["POST", "/documents", createBody(HOUSE)],
      ["PATCH", `/entities/${ASSET}`, updateBody(HOUSE)],
    ] as const) {
      const res = await send("synap_launcher_key", method, route, body);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(ACT_AS_REFUSED);
    }
    expect(h.reached).toEqual([]);
  });

  it("the launching agent's own key still writes as itself (the key rule is unchanged)", async () => {
    const res = await send(
      "synap_launcher_key",
      "PATCH",
      `/entities/${ASSET}`,
      updateBody(LAUNCHER)
    );
    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(h.reached[0]!.input).toMatchObject({ agentUserId: LAUNCHER });
  });
});
