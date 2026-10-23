/**
 * POST /files/{entityId}/transcribe for a SCOPED key — through the REAL hub
 * auth door (its W1 fence + `runWithGrant`), the REAL route, the REAL
 * `readableFileEntity` → `scopedDb(entities)` (grant ANDed) and the REAL
 * `transcribeStoredMedia` (owner check, mime + size limits, result mapping),
 * compiled and run as SQL on PGlite. Stubbed: the key lookup, the guest check,
 * the object store's `downloadBuffer`, and the provider at its seam —
 * `resolveIntelligenceService` → `client.transcribe` (the IS call).
 *
 * Why: an app holding a key with a per-workspace read grant transcribes a
 * stored audio/video file it can read; it must not spend a transcription on a
 * file in a workspace its grant does not cover.
 *
 * Owner question (asked by the founder): a file uploaded with an app/agent key
 * is stored under the key's HUMAN (`effectiveUserId = linkedUserId`, hub auth),
 * which is also the `userId` this door passes to the service — so the
 * service's `documents.userId = caller` check passes for the key's own
 * uploads. A TEAMMATE's file that the caller can read is refused (404): the
 * service only spends on the caller's own documents.
 *
 * Rows rule out: a read that skips the grant (the provider would be called for
 * the out-of-grant file), a door that forwards a non-media file, a 403 that
 * still spent a call, and a missing read scope passing.
 *
 * Cannot see: production Postgres, the real IS, the edge rate limiter (its
 * class is `apps/api/.../hub-transcribe-rate-class.test.ts`).
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
  scopes: ["hub-protocol.read"] as string[],
  transcribe: vi.fn(),
  resolveCalls: [] as Array<Record<string, unknown>>,
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
vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    getSignedUrl: async (key: string) => `https://signed.test/${key}`,
    downloadBuffer: async (key: string) => Buffer.from(`bytes-of:${key}`),
  },
}));
// The provider seam: `transcribeStoredMedia` → `transcribeViaIs` →
// `resolveIntelligenceService(...).client.transcribe(...)`.
vi.mock("../../../utils/intelligence-routing.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIntelligenceService: async (ctx: Record<string, unknown>) => {
    h.resolveCalls.push(ctx);
    return { client: { transcribe: h.transcribe } };
  },
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
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

const OWNER = randomUUID(); // the human whose pod it is (the key's human)
const AGENT = randomUUID(); // the key principal (an agent user, linked to OWNER)
const TEAMMATE = randomUUID(); // another human, member of WS_A
const WS_A = randomUUID(); // the workspace the app's grant covers
const WS_B = randomUUID(); // another of the owner's workspaces — NOT granted
const FILE_PROFILE = randomUUID();
const AUDIO_A = randomUUID(); // OWNER's audio in WS_A
const AUDIO_B = randomUUID(); // OWNER's audio in WS_B
const IMAGE_A = randomUUID(); // OWNER's image in WS_A (not media)
const TEAM_AUDIO_A = randomUUID(); // TEAMMATE's audio in WS_A

const KEYS = {
  pinned: {
    id: randomUUID(),
    permissions: ["entity.*.read"],
    workspaceIds: [WS_A] as string[] | null,
  },
  full: { id: randomUUID(), permissions: ["*"], workspaceIds: null },
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

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    TEAMMATE,
    "teammate@example.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "agent@example.test", OWNER]
  );
  for (const ws of [WS_A, WS_B]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `ws-${ws.slice(0, 4)}`, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), WS_A, TEAMMATE]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'file','File','kind','system','workspace',true,'{}'::jsonb,null)`,
    [FILE_PROFILE]
  );
  // Stored as the hub upload door stores a key's upload: the document and the
  // entity both under the key's HUMAN (`effectiveUserId`).
  for (const [entityId, owner, ws, key, mime] of [
    [AUDIO_A, OWNER, WS_A, "users/owner/a.mp3", "audio/mpeg"],
    [AUDIO_B, OWNER, WS_B, "users/owner/b.mp3", "audio/mpeg"],
    [IMAGE_A, OWNER, WS_A, "users/owner/a.png", "image/png"],
    [TEAM_AUDIO_A, TEAMMATE, WS_A, "users/team/a.mp3", "audio/mpeg"],
  ] as const) {
    const docId = randomUUID();
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type, size)
       values ($1,$2,$3,'f','file',$4,$5,1000)`,
      [docId, owner, ws, key, mime]
    );
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, document_id)
       values ($1,$2,$3,$4,'file','f','{}'::jsonb,'{}'::jsonb,$5)`,
      [entityId, owner, ws, FILE_PROFILE, docId]
    );
  }
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
  h.scopes = ["hub-protocol.read"];
  h.resolveCalls = [];
  h.transcribe.mockReset();
  h.transcribe.mockResolvedValue({
    ok: true,
    text: "  hello world  ",
    language: "en",
  });
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const name = bearer.replace(/^synap_/, "") as KeyName;
    return {
      status: "valid",
      record: {
        id: KEYS[name].id,
        userId: AGENT,
        linkedUserId: OWNER,
        parentKeyId: null,
        scope: h.scopes,
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
  registerEntitiesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const post = (key: KeyName, entityId: string) =>
  app().request(`/api/hub/files/${entityId}/transcribe`, {
    method: "POST",
    headers: { authorization: `Bearer synap_${key}` },
  });

type Body = { text?: string; lang?: string; error?: string; code?: string };

describe("POST /files/{entityId}/transcribe — bounded by the key's grant", () => {
  it("in-grant audio ⇒ 200 { text, lang }, the provider called once with THAT blob", async () => {
    const res = await post("pinned", AUDIO_A);
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toEqual({ text: "hello world", lang: "en" });
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.transcribe.mock.calls[0]![0]).toEqual({
      content: Buffer.from("bytes-of:users/owner/a.mp3").toString("base64"),
      mimeType: "audio/mpeg",
    });
    // Spent as the key's HUMAN, in the file's workspace.
    expect(h.resolveCalls[0]).toMatchObject({
      userId: OWNER,
      workspaceId: WS_A,
    });
  });

  it("a file in a workspace the grant does NOT cover ⇒ 403, nothing spent", async () => {
    const res = await post("pinned", AUDIO_B);
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.text).toBeUndefined();
    expect(body.code).not.toBe("GRANT_DOOR_UNSUPPORTED");
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it("control: the same file IS transcribed for a full-access key", async () => {
    const res = await post("full", AUDIO_B);
    expect(res.status).toBe(200);
    expect(h.transcribe).toHaveBeenCalledTimes(1);
  });

  it("a readable TEAMMATE's file ⇒ 404 (the service spends on own documents only)", async () => {
    const res = await post("full", TEAM_AUDIO_A);
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(404);
    expect(body.code).toBe("not_found");
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it("not audio/video ⇒ 415, nothing spent", async () => {
    const res = await post("pinned", IMAGE_A);
    expect(res.status).toBe(415);
    expect(((await res.json()) as Body).code).toBe("not_media");
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it("a provider refusal keeps its named state (budget ⇒ 422 refused)", async () => {
    h.transcribe.mockResolvedValueOnce({
      ok: false,
      status: 402,
      code: "llm_budget_exceeded",
      error: "budget",
    });
    const res = await post("pinned", AUDIO_A);
    expect(res.status).toBe(422);
    expect(((await res.json()) as Body).code).toBe("refused");
  });

  it("unknown ⇒ 404, non-uuid ⇒ 400, no read scope ⇒ 403 — never a call", async () => {
    expect((await post("pinned", randomUUID())).status).toBe(404);
    expect((await post("pinned", "not-a-uuid")).status).toBe(400);
    h.scopes = ["hub-protocol.write"];
    expect((await post("full", AUDIO_A)).status).toBe(403);
    expect(h.transcribe).not.toHaveBeenCalled();
  });
});
