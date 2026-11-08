/**
 * `GET /installations` with REAL scoped keys, through the REAL hub auth door
 * (its W1 grant fence), the REAL route and the REAL reads, run as SQL on
 * PGlite. Stubbed: the key lookup (each row is the shape `machine-connect.ts`
 * mints), the guest check.
 *
 * The founder's computer key (dogfood, 2026-11-08) was minted on 2026-11-01
 * with the "AI — read & propose" grant OF THAT DAY, which did not name
 * `installation` yet (it joined the preset on 2026-11-07). The door was
 * fenced `PERSON("installation")`, so `synap tools list` was answered 403
 * GRANT_DOOR_UNSUPPORTED on the computer's own read.
 *
 * Rows rule out:
 *   - the computer's own key refused when its grant does not name
 *     `installation` (the founder's key);
 *   - that key reading another of its person's computers, or a stranger's row
 *     on its own machine id (owner AND machine, never machine alone);
 *   - the door opening to another key with the same old grant: an agent
 *     key, even one hosted on that computer, reads per its grant only;
 *   - a key whose grant reads `installation` losing its read (CONTROL).
 *
 * Cannot see: production Postgres, the CLI's rendering of the answer.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aiDefaultCapabilities } from "@synap-core/types/grants";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  keys: new Map<string, Record<string, unknown>>(),
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
    getApiKeyStatus: async (bearer: string) => {
      const record = h.keys.get(bearer.replace(/^synap_/, ""));
      return record ? { status: "valid", record } : { status: "not_found" };
    },
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
import { registerInstallationsRoutes } from "./installations.js";
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

const PERSON = randomUUID(); // the person who approved the device flows
const STRANGER = randomUUID(); // another person of the pod
const MAC = randomUUID(); // the person's computer whose key asks
const OTHER_BOX = randomUUID(); // another computer of the same person
const HOSTED = randomUUID(); // an agent of the person, hosted on the Mac
const AGENT = randomUUID(); // an agent of the person on no computer

/** The AI preset as minted before `installation` joined it (2026-11-07). */
const OLD_AI = aiDefaultCapabilities().filter(
  (p) => !p.startsWith("installation")
);
/** The AI preset today: it reads `installation`. */
const NEW_AI = aiDefaultCapabilities();

/** The scopes `machine-connect.ts` gives a computer key (SETUP_AGENT_HUB_SCOPES). */
const SCOPES = ["hub-protocol.read", "hub-protocol.write"];
const KEYS = {
  macOld: { userId: MAC, permissions: OLD_AI },
  macNew: { userId: MAC, permissions: NEW_AI },
  otherBoxOld: { userId: OTHER_BOX, permissions: OLD_AI },
  hostedOld: { userId: HOSTED, permissions: OLD_AI },
  agentOld: { userId: AGENT, permissions: OLD_AI },
  agentNew: { userId: AGENT, permissions: NEW_AI },
} as const;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const install = (owner: string, machine: string, key: string) =>
  q(
    `insert into installations (user_id, kind, capability_key, machine_user_id, manifest, desired_state, status)
     values ($1, 'tool', $2, $3, '{}'::jsonb, 'installed', 'installed')`,
    [owner, key, machine]
  );

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, user_type) values ($1,$2,'human'), ($3,$4,'human')`,
    [PERSON, "person@example.test", STRANGER, "stranger@example.test"]
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id, agent_metadata) values
      ($1,'mac@example.test','Mac','agent','machine',$5,NULL,'{}'::jsonb),
      ($2,'box@example.test','Other box','agent','machine',$5,NULL,'{}'::jsonb),
      ($3,'hosted@example.test','Claude on the Mac','agent','claude-code',$5,$1,'{}'::jsonb),
      ($4,'agent@example.test','Cloud agent','agent','claude-code',$5,NULL,'{}'::jsonb)`,
    [MAC, OTHER_BOX, HOSTED, AGENT, PERSON]
  );
  await install(PERSON, MAC, "media-ffmpeg");
  await install(PERSON, MAC, "media-transcribe");
  await install(PERSON, OTHER_BOX, "media-ffmpeg");
  // A stranger's row on the Mac's own machine id: owner AND machine, so a
  // floor on the machine alone would show it.
  await install(STRANGER, MAC, "stranger-tool");

  for (const [name, k] of Object.entries(KEYS)) {
    const id = randomUUID();
    // The row machine-connect mints: a `user_pat`, linked to its person.
    await q(
      `insert into api_keys (id, user_id, key_type, linked_user_id, is_active, created_at)
       values ($1,$2,'user_pat',$3,true,now())`,
      [id, k.userId, PERSON]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, created_by)
       values ($1,$2,$3,$4,$5::text[],$4)`,
      [
        randomUUID(),
        id,
        k.userId,
        PERSON,
        `{${k.permissions.map((p) => `"${p}"`).join(",")}}`,
      ]
    );
    h.keys.set(name, {
      id,
      userId: k.userId,
      linkedUserId: PERSON,
      parentKeyId: null,
      scope: SCOPES,
      keyType: "user_pat",
      workspaceId: null,
      expiresAt: null,
    });
  }
}, 120_000);

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerInstallationsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

type Body = {
  code?: string;
  error?: string;
  items?: Array<{ computerId: string; capabilityKey: string }>;
};

async function read(key: KeyName, query = "?computer=me") {
  const res = await app().request(`/api/hub/installations${query}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const rows = (b: Body) =>
  (b.items ?? []).map(
    (i) =>
      `${i.computerId === MAC ? "mac" : i.computerId === OTHER_BOX ? "box" : i.computerId}:${i.capabilityKey}`
  );

describe("GET /installations — a computer's own key (user_pat, AI grant)", () => {
  it("the founder's key (grant without `installation`) reads what is on ITS computer", async () => {
    expect(OLD_AI.some((p) => p.startsWith("installation"))).toBe(false);
    expect(NEW_AI.some((p) => p.startsWith("installation"))).toBe(true);
    const { status, body } = await read("macOld");
    expect(status, JSON.stringify(body)).toBe(200);
    // Its person's rows on the Mac; never the other box's, never the
    // stranger's row on the Mac's machine id.
    expect(rows(body)).toEqual(["mac:media-ffmpeg", "mac:media-transcribe"]);
    // Its own id is the same question as "me".
    const byId = await read("macOld", `?computer=${MAC}`);
    expect(rows(byId.body)).toEqual(rows(body));
    // By capability, still on itself only.
    const byKey = await read(
      "macOld",
      "?computer=me&capabilityKey=media-ffmpeg"
    );
    expect(rows(byKey.body)).toEqual(["mac:media-ffmpeg"]);
  });

  it("the same key cannot read another computer, or all of them", async () => {
    const other = await read("macOld", `?computer=${OTHER_BOX}`);
    expect(other.status, JSON.stringify(other.body)).toBe(403);
    expect(other.body.code).toBe("OWN_COMPUTER_ONLY");
    const all = await read("macOld", "");
    expect(all.status).toBe(403);
    expect(all.body.code).toBe("OWN_COMPUTER_ONLY");
    // The other computer's own key reads its own row, not the Mac's.
    const box = await read("otherBoxOld");
    expect(box.status).toBe(200);
    expect(rows(box.body)).toEqual(["box:media-ffmpeg"]);
  });

  it("an agent key with the same grant is refused: it reads per its grant", async () => {
    for (const k of ["hostedOld", "agentOld"] as const) {
      const { status, body } = await read(k);
      expect(status, `${k} ${JSON.stringify(body)}`).toBe(403);
      expect(body.code).toBe("GRANT_DOOR_UNSUPPORTED");
    }
  });

  it("CONTROL: a key whose grant reads `installation` keeps its read through the owner floor", async () => {
    const mac = await read("macNew");
    expect(mac.status).toBe(200);
    expect(rows(mac.body)).toEqual([
      "mac:media-ffmpeg",
      "mac:media-transcribe",
    ]);
    // An agent on no computer: every computer of its person, never the stranger's.
    const all = await read("agentNew", "");
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(rows(all.body).sort()).toEqual(
      ["box:media-ffmpeg", "mac:media-ffmpeg", "mac:media-transcribe"].sort()
    );
  });
});
