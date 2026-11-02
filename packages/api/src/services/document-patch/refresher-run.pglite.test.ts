/**
 * Decision D4, END TO END: a bound refresher's automation run rewrites the AI
 * section it wrote itself, and nothing else, without a proposal.
 *
 * Driven for real on PGlite, from the run session to the stored document:
 *   `openRunSession` (the executor's own call: the automation, the run, the
 *   agent the run writes as) → `runResolvedSkill` (the post-gate runner
 *   `executeCapability` calls, with the `automationRun` the jobs IoC slot
 *   hands it) → the builtin `document.update` → `applyDocumentPatch` → the
 *   write through the real `claimDocumentRevision`.
 *
 * Before this, the executor ran `document.update` as the owner with no agent
 * and no session, so D4 could never apply (founder, 2 Nov: make it work end
 * to end). The jobs half (the capability step passing `automationRun` to the
 * router) is `capability-step-automation-run.test.ts`.
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose`: records the key the door chose, and applies
 *    `document.refresher_section_update` the way its seeded auto rule does
 *    (`ensureDocumentRefresherRule`, whose own suite is
 *    `ensure-narrative-rule.pglite.test.ts`); any other agent write proposes.
 *  - `loadEditableDocument`, `@synap/storage`, the realtime emit, the
 *    diagnostics lookups and the scope floor: as in
 *    `apply-document-patch.pglite.test.ts`.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  blobs: new Map<string, string>(),
  gate: [] as Array<{
    action: string;
    agentUserId?: string;
    sessionId?: string;
  }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      documents: schema.documents,
      documentVersions: schema.documentVersions,
      focusSessions: schema.focusSessions,
    } as never,
  });
  h.db = db;
  return {
    ...actual,
    db,
    uploadDocumentVersionSnapshot: async (i: {
      versionId: string;
      content: string | Buffer;
      mimeType?: string | null;
    }) => {
      const key = `versions/${i.versionId}`;
      h.blobs.set(key, String(i.content));
      return {
        storageUrl: key,
        storageKey: key,
        size: String(i.content).length,
        mimeType: i.mimeType ?? "text/markdown",
        checksum: `sha256:${createHash("sha256").update(String(i.content)).digest("hex")}`,
        contentPreview: String(i.content).slice(0, 100),
      };
    },
    emitDocumentContentReplaced: async () => ({ ok: true }),
  };
});

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

vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: {
      agentUserId?: string;
      sessionId?: string;
      action: string;
    }) => {
      h.gate.push({
        action: opts.action,
        agentUserId: opts.agentUserId,
        sessionId: opts.sessionId,
      });
      if (!opts.agentUserId || opts.action === "refresher_section_update") {
        return { granted: true };
      }
      return {
        granted: false,
        proposalId: "prop-1",
        proposalType: `document.${opts.action}`,
        summary: "s",
        reasoning: "r",
        reviewPath: "/open/prop-1",
        reviewUrl: "https://pod/open/prop-1",
      };
    },
  };
});

vi.mock("../../utils/document-edit-access.js", () => ({
  loadEditableDocument: async (_userId: string, documentId: string) => ({
    id: documentId,
  }),
}));

vi.mock("../cells/renderables.js", () => ({ listRenderables: async () => [] }));

vi.mock("../document-scope/document-scope.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const none = async () => new Set<string>();
  return {
    ...actual,
    podDocumentScopeFloor: () => ({ workspaces: none, visible: none }),
  };
});

vi.mock("../../access/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AccessContext: {
      ...(actual.AccessContext as object),
      operator: () => ({ withLens: () => ({}) }),
    },
    scopedDb: () => ({ findMany: async () => [] }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  automationRuns,
  documents,
  documentVersions,
  focusSessions,
} from "@synap/database/schema";
import { openRunSession } from "@synap/database";
import { runResolvedSkill } from "../capabilities/execute-capability.js";

/** The automation's runtime principal, an agent user (it created the automation). */
const AGENT = "agent-refresher";
const OTHER_AGENT = "agent-other";
const WS = "11111111-1111-4111-8111-111111111111";
const AUTOMATION = "66666666-6666-4666-8666-666666666666";

const DOCUMENT_UPDATE = {
  id: "skill-document-update",
  name: "document.update",
  kind: "builtin",
  providerSpec: null,
  metadata: null,
  parameters: null,
  executionMode: null,
};

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    let def = "";
    if (c.hasDefault) {
      if (typeof c.default === "number" || typeof c.default === "boolean")
        def = ` default ${c.default}`;
      else if (typeof c.default === "string")
        def = ` default '${c.default.replace(/'/g, "''")}'`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const section = (id: string, body: string, attrs: string) =>
  [`::::synap-section{id="${id}" ${attrs}}`, `## ${id}`, "", body, "::::"].join(
    "\n"
  );

/**
 * A living document bound to the refresher: the refresher's own section
 * (stamped, approved once), another agent's AI section, a person's section.
 */
const LIVING = [
  "# Weekly",
  "",
  section(
    "status",
    "Two PRs in review.",
    `owner="ai" refresher="${AUTOMATION}"`
  ),
  "",
  section("risks", "None.", `owner="ai" author="${OTHER_AGENT}"`),
  "",
  section("notes", "My own notes.", `owner="human"`),
  "",
].join("\n");

async function livingDocument(): Promise<string> {
  const id = randomUUID();
  const key = `u/document/${id}.md`;
  h.blobs.set(key, LIVING);
  const checksum = `sha256:${createHash("sha256").update(LIVING).digest("hex")}`;
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type, current_version, last_saved_version, content_revision, refresh_automation_id)
     values ($1, $2, $3, 'Weekly', 'markdown', $4, 'text/markdown', 1, 1, 1, $5)`,
    [id, AGENT, WS, key, AUTOMATION]
  );
  await q(
    `insert into document_versions (document_id, version, content, author, author_id, checksum)
     values ($1, 1, $2, 'user', $3, $4)`,
    [id, LIVING, AGENT, checksum]
  );
  return id;
}

async function content(id: string): Promise<string> {
  const { rows } = await q<{ storage_key: string }>(
    `select storage_key from documents where id = $1`,
    [id]
  );
  return h.blobs.get(rows[0]!.storage_key) ?? "";
}

/** The executor's own `openRunSession` call for an agent-owned automation. */
async function openRefresherRun(agentUserId: string | null = AGENT) {
  const runId = randomUUID();
  await q(`insert into automation_runs (id, automation_id) values ($1, $2)`, [
    runId,
    AUTOMATION,
  ]);
  const { sessionId } = await openRunSession({
    userId: AGENT,
    workspaceId: WS,
    goal: "Weekly refresh",
    source: "automation",
    automationId: AUTOMATION,
    automationRunId: runId,
    agentUserId: agentUserId ?? undefined,
    database: h.db as never,
  });
  return sessionId;
}

/** A capability step of the run: what `executeCapability` hands the runner. */
const runStep = (
  documentId: string,
  sectionId: string,
  automationRun: { sessionId: string; agentUserId: string | null } | null,
  extra: { agentUserId?: string | null } = {}
) =>
  runResolvedSkill(
    DOCUMENT_UPDATE,
    {
      documentId,
      ops: [
        {
          op: "upsert_section",
          id: sectionId,
          title: sectionId,
          body: "One PR left.",
        },
      ],
    },
    {
      userId: AGENT,
      workspaceId: WS,
      connectionSelector: null,
      agentUserId: extra.agentUserId ?? null,
      sessionId: null,
      automationRun,
    }
  );

beforeAll(async () => {
  for (const t of [documents, documentVersions, focusSessions, automationRuns])
    await h.client!.exec(ddlFor(t as PgTable));
});

beforeEach(() => {
  h.gate = [];
});

describe("D4 end to end: the refresher's run → document.update → the patch door", () => {
  it("the run rewrites the section it wrote itself under refresher_section_update, applied", async () => {
    const id = await livingDocument();
    const sessionId = await openRefresherRun();
    const ran = await runStep(id, "status", { sessionId, agentUserId: AGENT });
    expect(ran.kind).toBe("run");
    expect(h.gate).toEqual([
      {
        action: "refresher_section_update",
        agentUserId: AGENT,
        sessionId,
      },
    ]);
    const body = await content(id);
    expect(body).toContain("One PR left.");
    expect(body).not.toContain("Two PRs in review.");
    // The rewrite keeps the stamp, so the next run qualifies too.
    expect(body).toMatch(
      new RegExp(`synap-section\\{id="status"[^}]*refresher="${AUTOMATION}"`)
    );
    // The person's section is byte-for-byte untouched.
    expect(body).toContain(section("notes", "My own notes.", `owner="human"`));
  });

  it("an AI section another agent wrote is proposed, never rewritten", async () => {
    const id = await livingDocument();
    const sessionId = await openRefresherRun();
    await runStep(id, "risks", { sessionId, agentUserId: AGENT });
    expect(h.gate.map((g) => g.action)).toEqual(["section_update"]);
    expect(await content(id)).toBe(LIVING);
  });

  it("a NEW section is proposed (a person approves the refresher's section once)", async () => {
    const id = await livingDocument();
    const sessionId = await openRefresherRun();
    await runStep(id, "fresh", { sessionId, agentUserId: AGENT });
    expect(h.gate.map((g) => g.action)).toEqual(["section_update"]);
    expect(await content(id)).toBe(LIVING);
  });

  it("another agent, in the same run session, is proposed", async () => {
    const id = await livingDocument();
    const sessionId = await openRefresherRun();
    await runStep(
      id,
      "status",
      { sessionId, agentUserId: OTHER_AGENT },
      { agentUserId: OTHER_AGENT }
    );
    expect(h.gate.map((g) => g.action)).toEqual(["section_update"]);
    expect(await content(id)).toBe(LIVING);
  });
});
