/**
 * A REVIEWED write lands what was reviewed: the approve executors read the
 * caller's fields where the gate STORED them.
 *
 * `checkPermissionOrPropose` files a pending proposal as a request-shaped
 * envelope — the caller's object sits at `proposal.data.data`. Four executors
 * read it FLAT (`proposal.data.title`, `proposal.data.parentChannelId`, …), so
 * every reviewed create through them ran on `undefined`:
 *   - `document/create` wrote "Untitled" with an empty body (pod incident
 *     2026-10-19: proposal f94f6ba1 → document deb1a133), and an external
 *     reference became an empty stored body instead of a link;
 *   - `channel/create_branch`, `channel/merge_branch`, `channel/create_external`
 *     handed the channel writes no parent, no branch, no source.
 * Auto-approved writes skip the envelope, so only a reviewed write showed it.
 *
 * Driven end to end with nothing hand-built in between: the REAL hub door →
 * the REAL gate (an agent's write, proposed) → the stored proposal ROW read back
 * from PGlite → the REAL registered executor. For `document/create` the write
 * itself is real too (`materializeApprovedDocument` → `createDocumentWithContent`
 * on PGlite, blobs in memory); the assertion is the stored row and blob.
 *
 * Stubbed, and why:
 *  - the channel writes (`channelsRouter.createChannel` / `mergeBranch` /
 *    `createExternalChannel`) → recorders. The seam is WHAT the executor hands
 *    them; their own behaviour has its own suites. NOT covered: those writes.
 *  - `@synap/storage` → an in-memory blob map.
 *  - the receipt-session mint (`resolveOrCreateAgentProposalSession`) and the
 *    agent's declared focus (`getAgentFocusProjectId`) → null. The gate calls
 *    them on the module `db` while its proposal transaction is open; PGlite has
 *    ONE connection, so a read outside that transaction waits for it forever
 *    (every test here timed out at 120 s). Which session or project groups the
 *    proposal is not this seam; `permission-check.*.test.ts` stub them too.
 *  - the scoped-key middleware, audit log, side effects, realtime — not this
 *    seam. Attribution is the real one: every door runs inside
 *    `runWithActingAgent`, as the key-auth entry points do.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    blobs: new Map<string, string>(),
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
  };
  return state;
});

// The database package's own modules read `db` from client-pg, not the barrel.
vi.mock("../../../../../../database/dist/client-pg.js", () =>
  h.clientPgModule()
);
vi.mock("../../../../../../database/src/client-pg.js", () =>
  h.clientPgModule()
);
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return {
    ...actual,
    db: d,
    getDb: async () => d,
    EventRepository: class {
      async append() {
        return { id: randomUUID() };
      }
      async emitCompleted() {}
    },
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
    resolveOrCreateAgentProposalSession: async () => null,
  };
});
vi.mock(
  "../../../../services/agent-identity-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAgentFocusProjectId: async () => null,
  })
);
vi.mock("@synap/storage", () => ({
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
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../middleware/api-key-auth.js")
    >();
  const { t } =
    await vi.importActual<typeof import("../../../../trpc.js")>(
      "../../../../trpc.js"
    );
  return { ...actual, scopedProcedure: () => t.procedure };
});
vi.mock("../../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => ({ id: randomUUID() })),
}));
vi.mock("../../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../../services/links/links-service.js", () => ({
  createLinks: async () => [],
  createLink: async () => ({}),
}));
vi.mock(
  "../../../../services/focus-sessions/ensure-session-channel.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    ensureSessionChannel: async () => null,
  })
);
vi.mock("../../../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithActingAgent } from "@synap/database";
import { documentsRouter } from "../../../hub-protocol/documents.js";
import { branchesRouter } from "../../../hub-protocol/branches.js";
import { channelsRouter as hubChannelsRouter } from "../../../hub-protocol/channels.js";
import { channelsRouter } from "../../../channels.js";
import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerDocumentExecutors } from "../document.js";
import { registerChannelExecutors } from "../channel.js";

const USER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const PARENT = randomUUID();
const BRANCH = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    else if (c.hasDefault && type.endsWith("[]")) def = ` default '{}'`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** What the stubbed channel writes were handed, by procedure. */
const channelWrites: Array<{ door: string; input: Record<string, unknown> }> =
  [];

/** A door call as an agent key makes it: the acting agent is ambient. */
const asAgent = <T>(fn: () => Promise<T>) => runWithActingAgent(AGENT, fn);

/** The stored row, read back, handed to the REAL registered executor. */
async function approve(proposalId: string): Promise<void> {
  const { rows } = await q<Record<string, unknown>>(
    `select * from proposals where id = $1`,
    [proposalId]
  );
  const row = rows[0];
  if (!row) throw new Error(`no proposal row ${proposalId}`);
  const key = `${row.target_type}/${row.proposal_type}`;
  const exec = proposalExecRegistry.resolveExact(key);
  if (!exec) throw new Error(`no executor for ${key}`);
  await exec.execute({
    proposal: {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      projectId: row.project_id,
      agentUserId: row.agent_user_id,
      sourceMessageId: row.source_message_id,
      data: row.data,
    },
    payload: row.data,
    userId: USER,
    input: { proposalId },
    ctx: { authenticated: true, userId: USER },
    deps: {
      reportProposalOutcome: () => {},
      emitProposalReviewed: () => {},
    },
  } as unknown as ProposalExecutorArgs);
}

function proposedId(res: unknown): string {
  const r = res as { status?: string; proposalId?: string; message?: string };
  if (r.status !== "proposed" || !r.proposalId)
    throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposalId;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, name, user_type, created_by_user_id) values
      ($1, 'u@x.test', 'Ada', 'human', null),
      ($2, 'a@x.test', 'Scout', 'agent', $1)`,
    [USER, AGENT]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'Sales', $2, '{}'::jsonb)`,
    [WS, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
      ($1, $3, $4, 'owner'), ($2, $3, $5, 'editor')`,
    [randomUUID(), randomUUID(), WS, USER, AGENT]
  );
  await q(
    `insert into channels (id, workspace_id, user_id, title) values
      ($1, $3, $4, 'Pricing'), ($2, $3, $4, 'Pricing research')`,
    [PARENT, BRANCH, WS, USER]
  );
  // The person's own setting: "ask me before an agent creates a document"
  // (`document.create` otherwise auto-applies, which skips the envelope).
  await q(
    `insert into governance_rules (id, principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
     values ($1, 'any', 'pod', 'action', 'document.create', 'propose', $2)`,
    [randomUUID(), USER]
  );

  registerDocumentExecutors();
  registerChannelExecutors();

  vi.spyOn(channelsRouter, "createCaller").mockImplementation((() => ({
    createChannel: async (input: Record<string, unknown>) => {
      channelWrites.push({ door: "createChannel", input });
      return { channelId: randomUUID() };
    },
    mergeBranch: async (input: Record<string, unknown>) => {
      channelWrites.push({ door: "mergeBranch", input });
      return { success: true };
    },
    createExternalChannel: async (input: Record<string, unknown>) => {
      channelWrites.push({ door: "createExternalChannel", input });
      return { channelId: randomUUID() };
    },
  })) as never);
});

const hubDocuments = () =>
  documentsRouter.createCaller({ userId: USER, scopes: [] } as never);

describe("document/create — a reviewed document lands named and whole", () => {
  it("the approved document carries the reviewed title and body", async () => {
    const res = await asAgent(() =>
      hubDocuments().createDocument({
        userId: USER,
        title: "Bridge 1.0 plan",
        content: "Ship the reader first.\n\nThen the writer.\n",
      })
    );
    const proposalId = proposedId(res);
    const documentId = (res as { documentId: string }).documentId;

    await approve(proposalId);

    const { rows } = await q<{
      title: string;
      storage_key: string | null;
      user_id: string;
    }>(`select title, storage_key, user_id from documents where id = $1`, [
      documentId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Bridge 1.0 plan");
    expect(h.blobs.get(rows[0]!.storage_key ?? "")).toBe(
      "Ship the reader first.\n\nThen the writer.\n"
    );
    expect(rows[0]!.user_id).toBe(USER);
  });

  it("an approved external reference is a link, not an empty stored body", async () => {
    const url = "https://example.test/spec";
    const res = await asAgent(() =>
      hubDocuments().createDocument({
        userId: USER,
        title: "Vendor spec",
        url,
      })
    );
    const proposalId = proposedId(res);
    const documentId = (res as { documentId: string }).documentId;

    await approve(proposalId);

    const { rows } = await q<{
      title: string;
      storage_url: string | null;
      storage_key: string | null;
    }>(
      `select title, storage_url, storage_key from documents where id = $1`,
      [documentId]
    );
    expect(rows[0]).toEqual({
      title: "Vendor spec",
      storage_url: url,
      storage_key: null,
    });
  });
});

describe("channel executors — a reviewed channel write gets its target", () => {
  const hubBranches = () =>
    branchesRouter.createCaller({ userId: USER, scopes: [] } as never);

  it("create_branch: the parent, purpose and context choice reach the write", async () => {
    channelWrites.length = 0;
    const res = await asAgent(() =>
      hubBranches().createBranch({
        userId: USER,
        parentChannelId: PARENT,
        branchPurpose: "Compare the three pricing pages",
        inheritContext: false,
      })
    );
    await approve(proposedId(res));
    expect(channelWrites).toEqual([
      {
        door: "createChannel",
        input: expect.objectContaining({
          parentChannelId: PARENT,
          branchPurpose: "Compare the three pricing pages",
          inheritContext: false,
        }),
      },
    ]);
  });

  it("merge_branch: the branch and its summary reach the write", async () => {
    channelWrites.length = 0;
    const res = await asAgent(() =>
      hubBranches().mergeBranch({
        userId: USER,
        branchId: BRANCH,
        summary: "Tier B wins on every page.",
      })
    );
    await approve(proposedId(res));
    expect(channelWrites).toEqual([
      {
        door: "mergeBranch",
        input: { branchId: BRANCH, summary: "Tier B wins on every page." },
      },
    ]);
  });

  it("create_external: the source, its id and the title reach the write", async () => {
    channelWrites.length = 0;
    const res = await asAgent(() =>
      hubChannelsRouter
        .createCaller({ userId: USER, scopes: [] } as never)
        .createExternalChannel({
          userId: USER,
          workspaceId: WS,
          externalSource: "whatsapp",
          externalChannelId: "+33600000000",
          title: "WhatsApp: Inès",
        })
    );
    await approve(proposedId(res));
    expect(channelWrites).toEqual([
      {
        door: "createExternalChannel",
        input: expect.objectContaining({
          externalSource: "whatsapp",
          externalChannelId: "+33600000000",
          title: "WhatsApp: Inès",
        }),
      },
    ]);
  });
});
