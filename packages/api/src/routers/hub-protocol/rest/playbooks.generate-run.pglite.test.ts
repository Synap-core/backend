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
 *  - a filed proposal that does not name the run that drafted it
 *    (`data.run = { id, playbookId }`);
 *  - a second run on the same subject (`idempotentBySubject`) filing a second
 *    proposal while the first still waits;
 *  - a failed call leaving no record (the run row is `failed` with the error);
 *  - a NON-generate run changed (control: it still opens a session and a room
 *    and dispatches its executor, and makes no model call here);
 *  - past outcomes (slice 8, `lands.examples`): a playbook that opts in shows
 *    the person's last decided drafts of THIS playbook (approved as revised,
 *    rejected with the reason when given; never a pending one or another
 *    playbook's), records which in `generation.examples`; one that does not
 *    opt in reads none; a FAILED read is recorded as an error, never as
 *    "none", and the run still drafts; examples give way before the subject.
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
    /** The past-outcomes read throws (slice 8's failed-read row). */
    examplesFail: false,
    /** The record write after filing a draft throws (review finding 8). */
    settleFail: false,
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
// The real past-outcomes read, made to fail on demand.
// The one writer after an executor, made to fail on a `proposed` settle.
vi.mock("../../../services/playbooks/run-playbook.js", async (orig) => {
  const actual =
    await orig<typeof import("../../../services/playbooks/run-playbook.js")>();
  return {
    ...actual,
    recordExecutorResult: async (
      ...args: Parameters<typeof actual.recordExecutorResult>
    ) => {
      if (h.settleFail && args[1].status === "proposed") {
        throw new Error("record write failed (test)");
      }
      return actual.recordExecutorResult(...args);
    },
  };
});
vi.mock("../../../services/playbooks/generate-examples.js", async (orig) => {
  const actual =
    await orig<
      typeof import("../../../services/playbooks/generate-examples.js")
    >();
  return {
    ...actual,
    readPastOutcomes: async (
      args: Parameters<typeof actual.readPastOutcomes>[0]
    ) => {
      if (h.examplesFail) throw new Error("examples read failed (test)");
      return actual.readPastOutcomes(args);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerPlaybooksRoutes } from "./playbooks.js";
import { applyApprovedDocumentPatch } from "../../../services/document-patch/apply-document-patch.js";
import { executeGenerateRun } from "../../../services/playbooks/generate-run.js";
import { settleGenerateRunOnDecision } from "../../../services/playbooks/generate-run-decision.js";
import { emitProposalReviewed } from "../../proposals/apply-approval.js";
import { eq as eqCol } from "drizzle-orm";
import {
  buildGeneratePrompt,
  GENERATE_PROMPT_MAX_CHARS,
} from "../../../services/playbooks/generate-run.js";
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
const MEMBER = randomUUID(); // another member of the same space
const WS = randomUUID();
const OTHER_WS = randomUUID(); // a space the person is not in
const HIDDEN_POST = randomUUID(); // a post in OTHER_WS
const HIDDEN_DOC = randomUUID();
const GONE_POST = randomUUID(); // a deleted post in WS
const GONE_DOC = randomUUID();
const KEY = randomUUID();
const POST = randomUUID();
const POST_2 = randomUUID();
const DOC = randomUUID();
const DOC_2 = randomUUID();
const CAPTION = randomUUID(); // executor: generate
const AGENTIC = randomUUID(); // executor: is-agent (the control)
const CAPTION_EX = randomUUID(); // executor: generate, opts in to past outcomes
const CAPTION_MINE = randomUUID(); // executor: generate, lands in the person's own "## Caption"

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
  // The links writer upserts on this key (`createLink` on conflict do nothing).
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );

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
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    MEMBER,
    "member@example.test",
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'member')`,
    [randomUUID(), WS, MEMBER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Their space',$2,'{}'::jsonb)`,
    [OTHER_WS, MEMBER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), OTHER_WS, MEMBER]
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
    `insert into profiles (id, slug, display_name, scope, workspace_id, profile_kind) values ($1,'post','Post','system',null,'kind')`,
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
  // A post in a space the person is not in, and a deleted post in theirs.
  for (const [post, doc, ws, owner, title, deleted] of [
    [HIDDEN_POST, HIDDEN_DOC, OTHER_WS, MEMBER, "Their secret launch", false],
    [GONE_POST, GONE_DOC, WS, PERSON, "A deleted post", true],
  ] as const) {
    const key = `${owner}/documents/${doc}.md`;
    h.blobs.set(key, SCRIPT);
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, storage_key, current_version, content_revision, metadata)
       values ($1,$2,$3,$4,'markdown',$5,1,1,'{}'::jsonb)`,
      [doc, owner, ws, `${title} script`, key]
    );
    await q(
      `insert into entities (id, user_id, workspace_id, type, title, document_id, properties, system_data, version, deleted_at)
       values ($1,$2,$3,'post',$4,$5,'{}'::jsonb,'{}'::jsonb,1,$6)`,
      [post, owner, ws, title, doc, deleted ? new Date().toISOString() : null]
    );
  }
  const playbook = (
    id: string,
    name: string,
    executor: string,
    examples?: { approved?: number; rejected?: number },
    landing: { section: string; owner?: "person" } = {
      section: "Caption draft",
    }
  ) =>
    q(
      `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria, tools, guidance, requires, subject_profile, version)
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
              ...landing,
              ...(examples ? { examples } : {}),
            },
          },
        ]),
      ]
    );
  await playbook(CAPTION, "Write the caption", "generate");
  await playbook(AGENTIC, "Write the caption (agent)", "is-agent");
  await playbook(
    CAPTION_MINE,
    "Write the caption (into the person's caption)",
    "generate",
    undefined,
    { section: "Caption", owner: "person" }
  );
  await playbook(CAPTION_EX, "Write the caption (with examples)", "generate", {
    approved: 1,
    rejected: 2,
  });
}, 180_000);

beforeEach(async () => {
  h.generateCalls = [];
  h.dispatched = [];
  h.recalls = 0;
  h.examplesFail = false;
  h.settleFail = false;
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
    // A pending proposal nests the gate data under `data.data`
    // (`documentPatchPayload`, the one reading of that shape).
    const payload = (p.data.data ?? p.data) as Record<string, any>;
    expect(payload.ops).toEqual([
      {
        op: "upsert_section",
        id: "caption-draft",
        title: "Caption draft",
        body: DRAFT,
      },
    ]);
    expect(payload.author).toBe("system:generate-run");
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
    // The proposal names the run that drafted it: from a proposal, the run's
    // record (`GET /runs/:id`) is one read away.
    expect(payload.run).toEqual({ id: run.id, playbookId: CAPTION });
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

/** File one draft through the real door and return its proposal id. */
async function draft(playbookId: string, subjectId: string, text: string) {
  h.answer = text;
  const { status, body } = await runPlaybook(playbookId, subjectId);
  expect(status, JSON.stringify(body)).toBe(200);
  return body.generated.proposalId as string;
}

/**
 * Decide a filed draft as the person would: approve (optionally after a
 * revision, which rewrites the stored section body as the revise door does)
 * or reject (with or without a reason), at a given time.
 */
async function decide(
  proposalId: string,
  outcome: "approved" | "rejected",
  at: string,
  opts: { revisedBody?: string; reason?: string } = {}
) {
  const [row] = (
    await q<{ data: Record<string, any> }>(
      `select data from proposals where id = $1`,
      [proposalId]
    )
  ).rows;
  const data = row!.data;
  if (opts.revisedBody !== undefined) {
    const payload = (data.data ?? data) as Record<string, any>;
    payload.ops[0].body = opts.revisedBody;
  }
  await q(
    `update proposals set status = $2, reviewed_at = $3, rejection_reason = $4, data = $5::jsonb where id = $1`,
    [proposalId, outcome, at, opts.reason ?? null, JSON.stringify(data)]
  );
}

describe("past outcomes as context (lands.examples, slice 8)", () => {
  it("shows the person's last decided drafts of THIS playbook: approved as revised, rejected with the reason; records which", async () => {
    const pOld = await draft(CAPTION_EX, POST, "Old approved draft");
    const pNew = await draft(CAPTION_EX, POST, "First words of a draft");
    const pReason = await draft(CAPTION_EX, POST, "Buy now, limited offer");
    const pBare = await draft(CAPTION_EX, POST, "A draft rejected bare");
    const pOlderReject = await draft(CAPTION_EX, POST, "An older rejection");
    await draft(CAPTION_EX, POST, "A draft still pending");
    const pOther = await draft(CAPTION, POST, "Another playbook's draft");

    await decide(pOld, "approved", "2026-11-01T10:00:00Z");
    await decide(pNew, "approved", "2026-11-05T10:00:00Z", {
      revisedBody: "Your data should live where you decide, as I wrote it.",
    });
    await decide(pReason, "rejected", "2026-11-06T10:00:00Z", {
      reason: "Too salesy:\nnever say buy now",
    });
    await decide(pBare, "rejected", "2026-11-04T10:00:00Z");
    await decide(pOlderReject, "rejected", "2026-11-02T10:00:00Z");
    await decide(pOther, "approved", "2026-11-07T10:00:00Z");

    h.generateCalls = [];
    const pFinal = await draft(CAPTION_EX, POST_2, DRAFT);
    expect(h.generateCalls).toHaveLength(1);
    const prompt = h.generateCalls[0]!.prompt as string;

    // The block sits after the subject's document, before the answer line.
    const at = prompt.indexOf(
      '## Earlier "Caption draft" drafts the person decided'
    );
    expect(at).toBeGreaterThan(prompt.indexOf("S2: Your data lives"));
    expect(at).toBeLessThan(prompt.indexOf("## Your answer"));
    // approved: 1 = the most recently decided one, AS REVISED.
    expect(prompt).toContain(
      '### Approved for "Carousel 01", as the person kept it\nYour data should live where you decide, as I wrote it.'
    );
    expect(prompt).not.toContain("First words of a draft");
    expect(prompt).not.toContain("Old approved draft");
    // rejected: 2 = the two most recent, the reason on one line when given.
    expect(prompt).toContain(
      '### Rejected for "Carousel 01". Their reason: Too salesy: never say buy now\nBuy now, limited offer'
    );
    expect(prompt).toContain(
      '### Rejected for "Carousel 01"\nA draft rejected bare'
    );
    expect(prompt).not.toContain("An older rejection");
    // Never a pending draft, never another playbook's.
    expect(prompt).not.toContain("A draft still pending");
    expect(prompt).not.toContain("Another playbook's draft");
    expect(prompt.length).toBeLessThanOrEqual(GENERATE_PROMPT_MAX_CHARS);

    const run = (await runRows()).find(
      (r) => r.generation?.proposal?.id === pFinal
    )!;
    const runOf = async (pid: string) =>
      (await runRows()).find((r) => r.generation?.proposal?.id === pid)!.id;
    expect(run.generation!.examples).toEqual({
      asked: { approved: 1, rejected: 2 },
      used: [
        {
          outcome: "approved",
          proposalId: pNew,
          runId: await runOf(pNew),
          chars: expect.any(Number),
        },
        {
          outcome: "rejected",
          proposalId: pReason,
          runId: await runOf(pReason),
          chars: expect.any(Number),
          reason: true,
        },
        {
          outcome: "rejected",
          proposalId: pBare,
          runId: await runOf(pBare),
          chars: expect.any(Number),
        },
      ],
    });
    expect(
      run.generation!.context.map((c: { kind: string }) => c.kind)
    ).toEqual(["subject", "subject_document", "examples"]);

    // A playbook that does not opt in reads none, decided drafts or not.
    h.generateCalls = [];
    await draft(CAPTION, POST_2, DRAFT);
    expect(h.generateCalls[0]!.prompt).not.toContain("## Earlier");
    const plain = (await runRows()).at(-1)!;
    expect(plain.generation!.examples).toBeUndefined();
  });

  it("a FAILED read is recorded as an error, never as none, and the run still drafts", async () => {
    const pDecided = await draft(CAPTION_EX, POST, "A draft the person kept");
    await decide(pDecided, "approved", "2026-11-05T10:00:00Z");
    h.examplesFail = true;
    h.generateCalls = [];
    const { status, body } = await runPlaybook(CAPTION_EX, POST_2);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(h.generateCalls).toHaveLength(1);
    expect(h.generateCalls[0]!.prompt).not.toContain("## Earlier");
    const run = (await runRows()).find(
      (r) => r.generation?.proposal?.id === body.generated.proposalId
    )!;
    expect(run.status).toBe("proposed");
    expect(run.generation!.examples).toEqual({
      asked: { approved: 1, rejected: 2 },
      error: "examples read failed (test)",
    });
  });

  it("examples give way before the subject: left out (and recorded) when the subject fills the bound", () => {
    const example = (n: number) => ({
      outcome: "approved" as const,
      proposalId: `p${n}`,
      runId: `r${n}`,
      subjectTitle: `Post ${n}`,
      text: "x".repeat(1_400),
      reason: null,
    });
    const base = {
      method: { contextSkill: null, guidance: "" },
      goal: "Write the caption.",
      section: "Caption draft",
      subject: { id: "s", title: "Post", kind: "post", properties: {} },
      examples: [example(1), example(2)],
    };
    // Room for one example after the document: the second is left out.
    const roomy = buildGeneratePrompt({
      ...base,
      document: { id: "d", title: "Script", content: "y".repeat(19_000) },
    });
    expect(roomy.text.length).toBeLessThanOrEqual(GENERATE_PROMPT_MAX_CHARS);
    expect(roomy.text).toContain("y".repeat(19_000));
    expect(roomy.examples.used.map((u) => u.proposalId)).toEqual(["p1"]);
    expect(roomy.examples.overBound.map((o) => o.proposalId)).toEqual(["p2"]);
    expect(roomy.context.find((c) => c.kind === "examples")).toMatchObject({
      truncated: true,
    });
    // A document that fills the bound: no example at all, the subject first.
    const full = buildGeneratePrompt({
      ...base,
      document: { id: "d", title: "Script", content: "y".repeat(30_000) },
    });
    expect(full.text.length).toBeLessThanOrEqual(GENERATE_PROMPT_MAX_CHARS);
    expect(full.text).not.toContain("## Earlier");
    expect(full.examples.used).toEqual([]);
    expect(full.examples.overBound).toHaveLength(2);
    expect(full.context.map((c) => c.kind)).toEqual([
      "subject",
      "subject_document",
    ]);
  });
});

describe("a landing on the person's own target (lands.owner: person, decision of 10 Nov 2026)", () => {
  it("files ONE upsert_section of the person's plain block; approving it replaces the caption they saved: the one write", async () => {
    const { status, body } = await runPlaybook(CAPTION_MINE, POST_2);
    expect(status, JSON.stringify(body)).toBe(200);
    const [p] = (await proposalRows()).filter(
      (r) => r.id === body.generated.proposalId
    );
    const payload = (p!.data.data ?? p!.data) as Record<string, any>;
    // The kit's guard still holds: exactly one upsert_section from the pod.
    expect(payload.ops).toEqual([
      {
        op: "upsert_section",
        id: "caption",
        title: "Caption",
        body: DRAFT,
        form: "heading",
      },
    ]);
    expect(p).toMatchObject({
      status: "pending",
      created_by: "system:generate-run",
    });
    expect(body.generated).toMatchObject({
      sectionId: "caption",
      section: "Caption",
    });
    const run = (await runRows()).find(
      (r) => r.generation?.proposal?.id === p!.id
    )!;
    expect(run.generation!.lands).toEqual({
      target: "subject_document_section",
      section: "Caption",
      owner: "person",
    });

    // Nothing is written until the person approves.
    const key = `${PERSON}/documents/${DOC_2}.md`;
    expect(h.blobs.get(key)).toBe(SCRIPT);

    // Approving applies the stored op: the person's "## Caption" now holds
    // the draft, no AI section is added, every other line is kept.
    await applyApprovedDocumentPatch(
      {
        targetId: DOC_2,
        agentUserId: null,
        createdBy: "system:generate-run",
        data: p!.data,
      },
      PERSON
    );
    const [doc] = (
      await q<{ storage_key: string }>(
        `select storage_key from documents where id = $1`,
        [DOC_2]
      )
    ).rows;
    const after = h.blobs.get(doc!.storage_key)!;
    expect(after).toBe(
      SCRIPT.replace(
        "## Caption\nThe caption the person saved.",
        `## Caption\n\n${DRAFT}\n`
      )
    );
    expect(after).not.toContain("synap-section");
    expect(after).not.toContain("The caption the person saved.");
  });
});

// ── Review of the lean-runs wave (findings 2, 3, 4, 6, 7, 8, 9) ─────────────

/** Run a one-shot playbook as the scheduled path does: one open run per subject. */
async function scheduled(playbookId: string, subjectId: string) {
  const [pb] = await (h.db as any)
    .select()
    .from(schema.playbooks)
    .where(eqCol(schema.playbooks.id, playbookId));
  return executeGenerateRun({
    playbook: pb,
    workspaceId: WS,
    userId: PERSON,
    subjectId,
    params: {},
    runOn: null,
    idempotentBySubject: true,
  });
}

/** Another member's filed draft on a subject: its run row and its proposal. */
async function theirDraft(opts: {
  playbookId: string;
  subjectId: string;
  documentId: string;
  status: "pending" | "approved";
  body: string;
}) {
  const runId = randomUUID();
  const proposalId = randomUUID();
  const data = {
    data: {
      documentId: opts.documentId,
      ops: [
        {
          op: "upsert_section",
          id: "caption-draft",
          title: "Caption draft",
          body: opts.body,
        },
      ],
      baseRevision: 1,
    },
  };
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, created_by, reviewed_at, updated_at, created_at)
     values ($1,$2,'document',$3,'update',$4,$5::jsonb,'system:generate-run',$6,now(),now())`,
    [
      proposalId,
      WS,
      opts.documentId,
      opts.status,
      JSON.stringify(data),
      opts.status === "approved" ? new Date().toISOString() : null,
    ]
  );
  await q(
    `insert into playbook_runs (id, workspace_id, playbook_id, session_id, executor, status, generation, started_at, created_by)
     values ($1,$2,$3,null,'generate','proposed',$4::jsonb,now(),$5)`,
    [
      runId,
      WS,
      opts.playbookId,
      JSON.stringify({
        subjectId: opts.subjectId,
        lands: { target: "subject_document_section", section: "Caption draft" },
        proposal: {
          id: proposalId,
          reviewUrl: "x",
          reviewPath: "x",
          documentId: opts.documentId,
          sectionId: "caption-draft",
        },
      }),
      MEMBER,
    ]
  );
  return { runId, proposalId };
}

describe("one-shot runs stay the person's (review of the lean-runs wave)", () => {
  it("another member's decided drafts are never shown as this person's examples", async () => {
    await theirDraft({
      playbookId: CAPTION_EX,
      subjectId: POST,
      documentId: DOC,
      status: "approved",
      body: "MEMBER'S OWN APPROVED CAPTION",
    });
    h.generateCalls = [];
    const pFinal = await draft(CAPTION_EX, POST_2, DRAFT);
    expect(h.generateCalls[0]!.prompt).not.toContain(
      "MEMBER'S OWN APPROVED CAPTION"
    );
    const run = (await runRows()).find(
      (r) => r.generation?.proposal?.id === pFinal
    )!;
    expect(run.generation!.examples).toEqual({
      asked: { approved: 1, rejected: 2 },
      used: [],
    });
  });

  it("a subject in a space the person is not in, or deleted, is not found and never quoted", async () => {
    for (const subject of [HIDDEN_POST, GONE_POST]) {
      const { status, body } = await runPlaybook(CAPTION, subject);
      expect(status).toBe(404);
      expect(JSON.stringify(body)).not.toMatch(
        /Their secret launch|A deleted post/
      );
    }
    expect(h.generateCalls).toEqual([]);
    expect(await runRows()).toEqual([]);
  });

  it("reuse: the scheduled path returns the person's own pending draft, filing nothing new", async () => {
    const first = await scheduled(CAPTION, POST);
    const second = await scheduled(CAPTION, POST);
    expect(second.reused).toBe(true);
    expect(second.generated.proposalId).toBe(first.generated.proposalId);
    expect(h.generateCalls).toHaveLength(1);
    expect(await proposalRows()).toHaveLength(1);
  });

  it("reuse never hands this person another member's pending draft", async () => {
    const theirs = await theirDraft({
      playbookId: CAPTION,
      subjectId: POST,
      documentId: DOC,
      status: "pending",
      body: "MEMBER'S PENDING DRAFT",
    });
    const mine = await scheduled(CAPTION, POST);
    expect(mine.reused).toBeUndefined();
    expect(mine.generated.proposalId).not.toBe(theirs.proposalId);
    expect(h.generateCalls).toHaveLength(1);
  });

  it("two runs started together file ONE draft: the other waits on it", async () => {
    const results = await Promise.allSettled([
      scheduled(CAPTION, POST),
      scheduled(CAPTION, POST),
    ]);
    expect(await proposalRows()).toHaveLength(1);
    expect(h.generateCalls).toHaveLength(1);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const fresh = fulfilled.filter(
      (r) => !(r as PromiseFulfilledResult<{ reused?: true }>).value.reused
    );
    expect(fresh).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected")
        expect((r.reason as { code?: string }).code).toBe("CONFLICT");
    }
  });

  it("a pending draft the document moved past is not open: the next run drafts again", async () => {
    const first = await scheduled(CAPTION, POST);
    await q(
      `update documents set content_revision = content_revision + 1 where id = $1`,
      [DOC]
    );
    try {
      const second = await scheduled(CAPTION, POST);
      expect(second.reused).toBeUndefined();
      expect(second.generated.proposalId).not.toBe(first.generated.proposalId);
      expect(h.generateCalls).toHaveLength(2);
    } finally {
      await q(`update documents set content_revision = 1 where id = $1`, [DOC]);
    }
  });

  it("a run stuck running past the stale window is not open; a fresh one is", async () => {
    const stuck = (minutesAgo: number) =>
      q(
        `insert into playbook_runs (id, workspace_id, playbook_id, session_id, executor, status, generation, started_at, created_by)
         values ($1,$2,$3,null,'generate','running',$4::jsonb, now() - ($5 || ' minutes')::interval, $6)`,
        [
          randomUUID(),
          WS,
          CAPTION,
          JSON.stringify({ subjectId: POST }),
          String(minutesAgo),
          PERSON,
        ]
      );
    await stuck(10);
    const ok = await scheduled(CAPTION, POST);
    expect(ok.reused).toBeUndefined();
    await h.client!.exec("delete from playbook_runs; delete from proposals;");
    await stuck(1);
    await expect(scheduled(CAPTION, POST)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("a failure after the model call is recorded: run failed, the call's usage kept", async () => {
    h.answer = "   ";
    const { status } = await runPlaybook(CAPTION, POST);
    expect(status).toBeGreaterThanOrEqual(400);
    const [run] = await runRows();
    expect(run).toMatchObject({
      status: "failed",
      error: "The model answered with no draft text.",
    });
    expect(run!.generation).toMatchObject({
      inputTokens: 1800,
      outputTokens: 90,
      model: "claude-haiku-5-5",
    });
    expect(await proposalRows()).toEqual([]);
  });

  it("a filed draft whose record write fails is not a failed run: the proposal stands", async () => {
    h.settleFail = true;
    const { status, body } = await runPlaybook(CAPTION, POST);
    expect(status, JSON.stringify(body)).toBe(200);
    const [p] = await proposalRows();
    expect(p).toMatchObject({ status: "pending" });
    expect(body.generated.proposalId).toBe(p!.id);
    const [run] = await runRows();
    expect(run!.status).not.toBe("failed");
  });
});

describe("a one-shot run follows its draft's decision (cross-repo review, watch 10)", () => {
  it("approved: the run is completed, once", async () => {
    const pid = await draft(CAPTION, POST, DRAFT);
    expect(await settleGenerateRunOnDecision(pid, "approved")).toBe(
      "completed"
    );
    const [run] = await runRows();
    expect(run!.status).toBe("completed");
    // Already moved: nothing moves twice.
    expect(await settleGenerateRunOnDecision(pid, "approved")).toBeNull();
  });

  it("whichever door decides it: rejected → cancelled (discarded), reopened → proposed again", async () => {
    const pid = await draft(CAPTION, POST, DRAFT);
    emitProposalReviewed(pid, WS, "rejected", PERSON);
    await vi.waitFor(async () => {
      expect((await runRows())[0]!.status).toBe("cancelled");
    });
    emitProposalReviewed(pid, WS, "reopened", PERSON);
    await vi.waitFor(async () => {
      expect((await runRows())[0]!.status).toBe("proposed");
    });
  });

  it("a proposal no one-shot run filed moves no run", async () => {
    expect(
      await settleGenerateRunOnDecision(randomUUID(), "approved")
    ).toBeNull();
  });
});

describe("the prompt never overshoots its bound when the subject leaves almost no room", () => {
  it("every room left for the document, 0 to 40 characters included, stays under the bound", () => {
    const big = "x".repeat(1_000);
    const base: Record<string, unknown> = {};
    for (let i = 0; i < 21; i++) base[`p${i}`] = big;
    for (let n = 0; n < 1_000; n += 1) {
      const out = buildGeneratePrompt({
        method: { contextSkill: null, guidance: "" },
        goal: "Write the caption.",
        section: "Caption draft",
        subject: {
          id: "s",
          title: "Post",
          kind: "post",
          properties: { ...base, q: "y".repeat(n) },
        },
        document: { id: "d", title: "Script", content: "z".repeat(30_000) },
      });
      expect(out.text.length, `q of ${n}`).toBeLessThanOrEqual(
        GENERATE_PROMPT_MAX_CHARS
      );
    }
  });
});
