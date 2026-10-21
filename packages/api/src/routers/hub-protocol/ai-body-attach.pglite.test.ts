/**
 * FB1020 review M2 — an AI may attach only a document it may read AND that
 * belongs to the record's own space, and every AI attach is reviewed.
 *
 * THE DEFECT: `assertDocumentAttachable` passed any document the CALLER
 * authored, and an agent writes AS its person — so every document the person
 * ever wrote, in any space, passed. A first attach (an entity with no body)
 * rode `entity.update`, which auto-applies, so an agent could hand a private
 * document to every reader of a shared record (a body follows its entity on
 * the read floors), and the forced review keyed on `agentUserId` alone missed
 * an unattributed hub key (`source: "intelligence"`).
 *
 * Driven through the REAL Bearer door with the REAL gate, on PGlite with every
 * table: `hubProtocolRouter` → `apiKeyMiddleware` → hub `updateEntity` →
 * `entities.update` → `assertDocumentAttachable` → `checkPermissionOrPropose`
 * (not mocked — the seam under test). Only the key lookup / identity are
 * stubbed, plus delivery side effects.
 *
 * Rows, each ruling out a wrong rule:
 *  - another space's document onto a shared record → REFUSED, nothing filed
 *    (rules out "authored by the caller is enough" for an AI);
 *  - the person's personal document onto a shared record → REFUSED;
 *  - a same-space document → FILED for review, body unchanged (rules out
 *    "a first attach auto-applies");
 *  - the upload shape (the person's document onto a pod-wide record) →
 *    allowed, but reviewed (rules out a blanket cross-space refusal that
 *    would break agent uploads);
 *  - an attributed agent too (not only the unattributed key);
 *  - CONTROL: an agent's FIRST attach of a document it wrote itself stays on
 *    the ordinary lane (`synap_create_document({ entityId })`);
 *  - CONTROL: a person attaching their own document from another space still
 *    applies directly (the human rule is unchanged).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  agentUserId: undefined as string | undefined,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: "event" }) }
  );
  return { ...actual, db: h.db, getDb: async () => h.db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: vi.fn(async () => ({
      id: "22222222-2222-4222-8222-222222222222",
      userId: "user-m2",
      linkedUserId: null,
      keyName: "m2",
      keyType: "user_pat",
      workspaceId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
    })),
    checkRateLimit: vi.fn(() => true),
  },
}));
vi.mock("../../access/key-identity.js", () => ({
  resolveKeyIdentity: vi.fn(async () => ({
    effectiveUserId: "user-m2",
    agentUserId: h.agentUserId,
    grant: null,
  })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { hubProtocolRouter } from "./index.js";
import { entitiesRouter } from "../entities.js";

const USER = "user-m2";
const AGENT = randomUUID();
const W1 = randomUUID(); // the person's private space
const W2 = randomUUID(); // a shared space the record lives in
const NOTE_PROFILE = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function hub(agentUserId?: string) {
  h.agentUserId = agentUserId;
  const req = new Request("http://pod.test/api/hub/trpc/x", {
    headers: { authorization: "Bearer sk_test", "x-workspace-id": W2 },
  });
  return hubProtocolRouter.createCaller({
    req,
    authenticated: false,
    workspaceId: W2,
  } as never);
}

async function doc(
  workspaceId: string | null,
  agentUserId: string | null = null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, agent_user_id, created_at, updated_at)
     values ($1, $2, $3, 'private notes', 'markdown', $4, now(), now())`,
    [id, USER, workspaceId, agentUserId]
  );
  return id;
}

async function record(workspaceId: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, properties, created_at, updated_at)
     values ($1, $2, 'note', $3, 'shared note', $4, '{}', now(), now())`,
    [id, USER, NOTE_PROFILE, workspaceId]
  );
  return id;
}

async function bodyOf(entityId: string): Promise<string | null> {
  const { rows } = await q<{ document_id: string | null }>(
    `select document_id from entities where id = $1`,
    [entityId]
  );
  return rows[0]?.document_id ?? null;
}

const proposalCount = async () =>
  (await q(`select id from proposals`)).rows.length;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    USER,
    `${USER}@x`,
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type) values ($1, 'agent-m2@x', 'agent', $2, 'claude-code')`,
    [AGENT, USER]
  );
  await q(
    `insert into workspaces (id, owner_id, name) values ($1, $3, 'Private'), ($2, $3, 'Shared')`,
    [W1, W2, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values (gen_random_uuid(), $1, $3, 'owner'), (gen_random_uuid(), $2, $3, 'owner')`,
    [W1, W2, USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, scope, entity_scope, profile_kind, is_active, origin, ui_hints, default_values)
     values ($1, 'note', 'Note', 'system', 'pod', 'kind', true, 'authored', '{}', '{}')`,
    [NOTE_PROFILE]
  );
});

describe("an AI attaches a body only from the record's own space (M2)", () => {
  it("another space's document onto a shared record is REFUSED, nothing filed", async () => {
    const entityId = await record(W2);
    const documentId = await doc(W1);
    const before = await proposalCount();
    await expect(
      hub().entities.updateEntity({ entityId, userId: USER, documentId })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/another space than this record/),
    });
    expect(await bodyOf(entityId)).toBeNull();
    expect(await proposalCount()).toBe(before);
  });

  it("the person's personal (space-less) document onto a shared record is REFUSED", async () => {
    const entityId = await record(W2);
    const documentId = await doc(null);
    await expect(
      hub().entities.updateEntity({ entityId, userId: USER, documentId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await bodyOf(entityId)).toBeNull();
  });
});

describe("every AI body attach is reviewed (M2)", () => {
  it("a same-space document onto a record with no body is FILED, not applied", async () => {
    const entityId = await record(W2);
    const documentId = await doc(W2);
    const res = await hub().entities.updateEntity({
      entityId,
      userId: USER,
      documentId,
    });
    expect(res.status).toBe("proposed");
    expect(await bodyOf(entityId)).toBeNull();
    const { rows } = await q<{ status: string; data: { data?: unknown } }>(
      `select status, data from proposals where target_id = $1`,
      [entityId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.data.data).toMatchObject({ documentId });
  });

  it("the upload shape — the person's document onto a pod-wide record — is allowed, and reviewed", async () => {
    const entityId = await record(null);
    const documentId = await doc(W1);
    const res = await hub().entities.updateEntity({
      entityId,
      userId: USER,
      documentId,
    });
    expect(res.status).toBe("proposed");
    expect(await bodyOf(entityId)).toBeNull();
  });

  it("an ATTRIBUTED agent's same-space attach is filed too", async () => {
    const entityId = await record(W2);
    const documentId = await doc(W2);
    const res = await hub(AGENT).entities.updateEntity({
      entityId,
      userId: USER,
      documentId,
    });
    expect(res.status).toBe("proposed");
    expect(await bodyOf(entityId)).toBeNull();
  });
});

describe("CONTROL — an agent attaching a document IT wrote", () => {
  it("a first attach of the agent's own document stays on the ordinary lane", async () => {
    // `synap_create_document({ entityId })`: the agent writes a document and
    // attaches it — nothing of the person's is handed over.
    const entityId = await record(W2);
    const documentId = await doc(W2, AGENT);
    const res = await hub(AGENT).entities.updateEntity({
      entityId,
      userId: USER,
      documentId,
    });
    expect(res.status).toBe("updated");
    expect(await bodyOf(entityId)).toBe(documentId);
  });
});

describe("CONTROL — the person's own rule is unchanged", () => {
  it("a person attaches their own document from another space directly", async () => {
    const entityId = await record(W2);
    const documentId = await doc(W1);
    const res = await entitiesRouter
      .createCaller({
        authenticated: true,
        userId: USER,
        workspaceId: W2,
      } as never)
      .update({ id: entityId, documentId, source: "user" });
    expect(res.status).toBe("updated");
    expect(await bodyOf(entityId)).toBe(documentId);
  });
});
