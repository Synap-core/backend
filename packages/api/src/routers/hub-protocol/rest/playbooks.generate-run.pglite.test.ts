/**
 * A ONE-SHOT playbook run (`executor: "generate"`, plan 08e4fba7 slice 1)
 * through the REAL Hub door: `POST /api/hub/playbooks/:id/run` behind the REAL
 * hub auth middleware, the real run door (`runPlaybookDoor` →
 * `playbooksRouter.run` → `runPlaybook`), the real generate run, the real
 * document patch door and the real governance gate filing the proposal, on
 * PGlite.
 *
 * Rows rule out:
 *  - a generate run that makes more or fewer than ONE `ai.generate` call, or
 *    one carrying no subject, no document or no rules;
 *  - a draft written straight into the document instead of PROPOSED (the
 *    document's stored body must be unchanged, one pending proposal on it,
 *    authored by the pod's machine marker, an AI-owned section);
 *  - a run with no record: exactly one `playbook_runs` row, `session_id`
 *    NULL, `executor` generate, status `proposed`, the call's tokens, model,
 *    cost, finish reason and prompt text on its `generation`;
 *  - a session, a room, a recall, or a dispatched executor for a generate run;
 *  - the door's answer missing the proposal id, its review link or the run id;
 *  - a second run on the same subject (`idempotentBySubject`) filing a second
 *    proposal while the first still waits;
 *  - a failed call leaving no record (the run row is `failed` with the error);
 *  - a NON-generate run changed (control: it still opens a session and a room
 *    and dispatches its executor, and makes no model call here).
 *
 * Mocked: the key lookup and its side reads (guest check, sub-token mapping,
 * person-token classification), the audit log, the event log, realtime, the
 * blob store (an in-memory map), the IS seam (`generateViaIS`: what the model
 * answered and the usage it reported, through the real telemetry channel),
 * the executor registry (a spy: what "dispatched" means for the control run),
 * the recall enqueue (a spy) and the needs-you notifier. Cannot see:
 * production Postgres, a real IS, the inline approval in the app.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID, createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
    getApiKeyStatus: null as null | ((bearer: string) => Promise<unknown>),
    blobs: new Map<string, string>(),
    generateCalls: [] as Array<Record<string, unknown>>,
    /** What the model answers next; an Error is thrown instead. */
    answer: "" as string | Error,
    dispatched: [] as string[],
    recalls: 0,
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
  };
  return state;
});

// The database package's own modules read `db` from client-pg, not the barrel.
vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = await h.init();
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
    // The gate calls it on the module `db` while its proposal transaction is
    // open; PGlite has ONE connection (skills.proposal-names-skill.pglite).
    resolveOrCreateAgentProposalSession: async () => null,
  };
});
vi.mock("../../../services/agent-identity-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("../../../utils/split-brain-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    buildPath: (u: string, k: string, id: string, ext: string) =>
      `${u}/${k}/${id}.${ext}`,
    upload: async (key: string, body: string | Buffer) => {
      const text = Buffer.isBuffer(body) ? body.toString("utf-8") : body;
      h.blobs.set(key, text);
      const checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
      return { url: key, path: key, size: text.length, checksum };
    },
    downloadBuffer: async (key: string) =>
      Buffer.from(h.blobs.get(key) ?? "", "utf-8"),
  },
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: globalThis.crypto.randomUUID() })),
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (bearer: string) => h.getApiKeyStatus!(bearer),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));
vi.mock("../../../services/app-person-token.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  classifyAppPersonKey: async (args: { grant: unknown }) => ({
    kind: "person",
    grant: args.grant,
  }),
}));
// THE IS SEAM: the one model call. It reports its usage through the real
// telemetry channel (`recordAiUsage`), exactly as `generateViaIS` does.
vi.mock("../../../services/mail-feed/generate.js", async () => {
  const { recordAiUsage } = await import("@synap/intelligence-client");
  return {
    generateViaIS: async (args: Record<string, unknown>) => {
      h.generateCalls.push(args);
      if (h.answer instanceof Error) throw h.answer;
      recordAiUsage({
        finishReason: "stop",
        promptTokens: 1800,
        completionTokens: 90,
        totalTokens: 1890,
        model: "claude-haiku-5-5",
        cachedPromptTokens: 0,
        costUsd: 0.0021,
      });
      return h.answer;
    },
  };
});
// "Dispatched" = a session executor was asked to run (the control run).
vi.mock("../../../services/playbooks/executors/registry.js", () => ({
  resolveExecutor: (ref: string) => ({
    ref,
    run: async () => {
      h.dispatched.push(ref);
      return { status: "running" };
    },
  }),
}));
vi.mock("../../../services/focus-sessions/session-recall.js", () => ({
  enqueueSessionRecall: async () => {
    h.recalls += 1;
  },
}));
vi.mock("../../../services/focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => undefined,
}));
vi.mock("../../../services/playbooks/playbook-skill-preflight.js", () => ({
  findUnenabledPlaybookSkills: async () => [],
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerPlaybooksRoutes } from "./playbooks.js";
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
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "started_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const PERSON = randomUUID();
const WS = randomUUID();
const KEY = randomUUID();
const POST = randomUUID();
const POST_2 = randomUUID();
const DOC = randomUUID();
const DOC_2 = randomUUID();
const CAPTION = randomUUID(); // executor: generate
const AGENTIC = randomUUID(); // executor: is-agent (the control)

const SCRIPT = [
  "S1: You do not own your digital life.",
  "S2: Your data lives on servers you never chose.",
  "",
  "## Caption",
  "The caption the person saved.",
].join("\n");
const DRAFT =
  "Your data should live where you decide.\n\nThree questions to ask your apps.\n\nFollow for the next one.";

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    PERSON,
    "person@example.test",
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), PERSON]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Content OS',$2,'{}'::jsonb)`,
    [WS, PERSON]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, PERSON]
  );
  // The person's own key: unbounded, acting as the person.
  await q(
    `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$2,true)`,
    [KEY, PERSON]
  );
  await q(
    `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by, client_id)
     values ($1,$2,$3,$3,'{*}'::text[],null,$3,null)`,
    [randomUUID(), KEY, PERSON]
  );
  await q(
    `insert into profiles (id, slug, name, workspace_id, profile_kind) values ($1,'post','Post',null,'kind')`,
    [randomUUID()]
  );
  for (const [post, doc, title] of [
    [POST, DOC, "Carousel 01"],
    [POST_2, DOC_2, "Carousel 02"],
  ] as const) {
    const key = `${PERSON}/documents/${doc}.md`;
    h.blobs.set(key, SCRIPT);
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, storage_key, current_version, content_revision, metadata)
       values ($1,$2,$3,$4,'markdown',$5,1,1,'{}'::jsonb)`,
      [doc, PERSON, WS, `${title} script`, key]
    );
    await q(
      `insert into entities (id, user_id, workspace_id, type, title, document_id, properties, system_data, version)
       values ($1,$2,$3,'post',$4,$5,$6::jsonb,'{}'::jsonb,1)`,
      [
        post,
        PERSON,
        WS,
        title,
        doc,
        JSON.stringify({
          "post-hook": "You don't own your digital life",
          "post-cta": "Follow for more",
          "post-platform": "instagram",
        }),
      ]
    );
  }
  const playbook = (id: string, name: string, executor: string) =>
    q(
      `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria, required_intents, guidance, requires, subject_profile, version)
       values ($1,$2,$3,$4,'Draft the caption of this post ({post}) from its hook and its script.',$5,'active','{}'::jsonb,$6::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,$7::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'{"profileSlug":"post"}'::jsonb,1)`,
      [
        id,
        WS,
        PERSON,
        name,
        executor,
        JSON.stringify([
          { name: "post", type: "entity", label: "Post", required: true },
        ]),
        JSON.stringify([
          {
            kind: "document",
            label: "Caption draft",
            relationToSubject: "none",
            lands: {
              target: "subject_document_section",
              section: "Caption draft",
            },
          },
        ]),
      ]
    );
  await playbook(CAPTION, "Write the caption", "generate");
  await playbook(AGENTIC, "Write the caption (agent)", "is-agent");
}, 180_000);

beforeEach(async () => {
  h.generateCalls = [];
  h.dispatched = [];
  h.recalls = 0;
  h.answer = DRAFT;
  h.getApiKeyStatus = async () => ({
    status: "valid",
    record: {
      id: KEY,
      userId: PERSON,
      linkedUserId: PERSON,
      parentKeyId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      keyType: "hub_inbound",
      workspaceId: null,
      expiresAt: null,
    },
  });
  await h.client!.exec(
    "delete from playbook_runs; delete from focus_sessions; delete from channels; delete from proposals; delete from links;"
  );
});

function hubApp() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerPlaybooksRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

async function runPlaybook(playbookId: string, subjectId: string) {
  const json = JSON.stringify({ workspaceId: WS, subjectId });
  const res = await hubApp().request(`/api/hub/playbooks/${playbookId}/run`, {
    method: "POST",
    headers: {
      authorization: "Bearer synap_person",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(json)),
    },
    body: json,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

const runRows = () =>
  q<{
    id: string;
    session_id: string | null;
    executor: string;
    status: string;
    error: string | null;
    generation: Record<string, any> | null;
  }>(
    `select id, session_id, executor, status, error, generation from playbook_runs order by started_at`
  ).then((r) => r.rows);
const proposalRows = () =>
  q<{
    id: string;
    status: string;
    target_type: string;
    target_id: string;
    created_by: string;
    session_id: string | null;
    data: Record<string, any>;
  }>(
    `select id, status, target_type, target_id, created_by, session_id, data from proposals`
  ).then((r) => r.rows);
const count = (table: string) =>
  q<{ n: number }>(`select count(*)::int as n from ${table}`).then(
    (r) => r.rows[0]!.n
  );

describe("a one-shot (generate) playbook run through the Hub door", () => {
  it("makes ONE ai.generate call, files ONE proposal on the subject, writes ONE session-less run row with its record", async () => {
    const { status, body } = await runPlaybook(CAPTION, POST);
    expect(status, JSON.stringify(body)).toBe(200);

    // ONE model call, made from the subject, its document and the goal.
    expect(h.generateCalls).toHaveLength(1);
    const call = h.generateCalls[0]!;
    expect(call.prompt).toContain(
      "Draft the caption of this post (Carousel 01)"
    );
    expect(call.prompt).toContain(
      "- post-hook: You don't own your digital life"
    );
    expect(call.prompt).toContain(
      "S2: Your data lives on servers you never chose."
    );
    expect(call.prompt).toContain('Answer with the "Caption draft" text only');
    expect(call.system).toMatch(/reviews it before it is used/);

    // ONE pending proposal on the subject's document, authored by the pod's
    // machine marker: an AI-owned "Caption draft" section, nothing applied.
    const proposals = await proposalRows();
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p).toMatchObject({
      status: "pending",
      target_type: "document",
      target_id: DOC,
      created_by: "system:generate-run",
      session_id: null,
    });
    expect(p.data.ops).toEqual([
      {
        op: "upsert_section",
        id: "caption-draft",
        title: "Caption draft",
        body: DRAFT,
      },
    ]);
    expect(p.data.author).toBe("system:generate-run");
    // The stored document is untouched until the person approves.
    const [doc] = (
      await q<{ storage_key: string; content_revision: number }>(
        `select storage_key, content_revision from documents where id = $1`,
        [DOC]
      )
    ).rows;
    expect(h.blobs.get(doc!.storage_key)).toBe(SCRIPT);
    expect(doc!.content_revision).toBe(1);

    // ONE run row: no session, the call's record on it.
    const runs = await runRows();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run).toMatchObject({
      session_id: null,
      executor: "generate",
      status: "proposed",
      error: null,
    });
    expect(run.generation).toMatchObject({
      subjectId: POST,
      lands: { target: "subject_document_section", section: "Caption draft" },
      model: "claude-haiku-5-5",
      inputTokens: 1800,
      cachedInputTokens: 0,
      outputTokens: 90,
      totalTokens: 1890,
      costUsd: 0.0021,
      finishReason: "stop",
      outputChars: DRAFT.length,
      proposal: { id: p.id, documentId: DOC, sectionId: "caption-draft" },
    });
    expect(run.generation!.prompt.text).toBe(call.prompt);
    expect(
      run.generation!.context.map((c: { kind: string }) => c.kind)
    ).toEqual(["subject", "subject_document"]);

    // NO session, room, recall or dispatched agent turn.
    expect(await count("focus_sessions")).toBe(0);
    expect(await count("channels")).toBe(0);
    expect(h.recalls).toBe(0);
    expect(h.dispatched).toEqual([]);

    // The door's answer, synchronous: the proposal, its review link, the run.
    expect(body).toMatchObject({
      status: "generated",
      session: null,
      proposalId: p.id,
      run: { id: run.id, status: "proposed" },
      generated: {
        runId: run.id,
        status: "proposed",
        proposalId: p.id,
        subjectId: POST,
        documentId: DOC,
        sectionId: "caption-draft",
        section: "Caption draft",
      },
    });
    expect(typeof body.generated.reviewUrl).toBe("string");
    expect(body.generated.reviewUrl).toContain(p.id);
  });

  it("a failed call is still recorded: the run row is failed with the error, no proposal is filed", async () => {
    h.answer = new Error("IS generate failed (502)");
    const { status } = await runPlaybook(CAPTION, POST_2);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(h.generateCalls).toHaveLength(1);
    expect(await proposalRows()).toEqual([]);
    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      session_id: null,
      executor: "generate",
      status: "failed",
      error: "IS generate failed (502)",
    });
    expect(await count("focus_sessions")).toBe(0);
  });
});

describe("control: a NON-generate run is unchanged", () => {
  it("opens a session and a room and dispatches its executor, with no model call from the pod", async () => {
    const { status, body } = await runPlaybook(AGENTIC, POST);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("running");
    expect(h.generateCalls).toEqual([]);
    expect(h.dispatched).toEqual(["is-agent"]);
    expect(await count("focus_sessions")).toBe(1);
    expect(await count("channels")).toBe(1);
    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.session_id).not.toBeNull();
    expect(runs[0]!.executor).toBe("is-agent");
    expect(runs[0]!.generation).toBeNull();
  });
});
