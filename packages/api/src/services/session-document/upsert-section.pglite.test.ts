/**
 * The session-document SECTION WRITE DOOR, driven for real on PGlite.
 *
 * Real: `upsertSessionDocumentSection` (designation, base-version check,
 * ownership refusal, the compare-and-set version write, the undo checkpoint),
 * `recordSessionArtifact`, `ensureSessionNarrativeRule` (the seeded D10 rule),
 * `resolveGovernanceRule` + `decideAgentPolicy` (rung 2.8 and every rung below
 * it), and `applyApprovedDocumentPatch` (the approval half — here reading a
 * section proposal filed BEFORE W4b, in its legacy `sectionId/title/body` shape).
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose` — replaced by a thin gate that runs the REAL
 *    rule resolver and the REAL policy engine on the key the door chose. What
 *    it does NOT model: workspace RBAC, the daily ceiling, origin trust, a
 *    session's force-propose and proposal-row filing — each has its own suite.
 *    The seam under test is door → (subjectType, action) → stored rule →
 *    verdict.
 *  - `@synap/storage` + `uploadDocumentVersionSnapshot` — an in-memory blob map.
 *  - `DocumentRepository` — writes the same two rows (document + v1) straight
 *    to PGlite; its own suite covers the repository.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blobs: new Map<string, string>(),
  gateActions: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        documents: schema.documents,
        documentVersions: schema.documentVersions,
        focusSessions: schema.focusSessions,
        artifacts: schema.artifacts,
        governanceRules: schema.governanceRules,
      } as never,
    }),
    eventRepository: { append: async () => undefined },
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
        checksum: `sha256:${(await import("node:crypto")).createHash("sha256").update(String(i.content)).digest("hex")}`,
        contentPreview: String(i.content).slice(0, 100),
      };
    },
    DocumentRepository: class {
      async create(
        data: {
          id: string;
          title: string;
          storageKey: string;
          workspaceId: string | null;
        },
        userId: string
      ) {
        await client.query(
          `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type, current_version, last_saved_version)
           values ($1, $2, $3, $4, 'markdown', $5, 'text/markdown', 1, 1)`,
          [data.id, userId, data.workspaceId, data.title, data.storageKey]
        );
        await client.query(
          // checksum = sha256('') — the empty body the document is created with.
          `insert into document_versions (document_id, version, content, author, author_id, checksum)
           values ($1, 1, '', 'user', $2, 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')`,
          [data.id, userId]
        );
        return { id: data.id, title: data.title };
      }
    },
  };
});

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (u: string, k: string, id: string, ext: string) =>
      `${u}/${k}/${id}.${ext}`,
    upload: async (key: string, body: string | Buffer) => {
      const text = Buffer.isBuffer(body) ? body.toString("utf-8") : body;
      h.blobs.set(key, text);
      // The real providers' checksum shape: the content-write door compares
      // it against the last checkpoint to decide whether content drifted.
      const { createHash } = await import("node:crypto");
      const checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
      return { url: key, path: key, size: 1, checksum };
    },
    downloadBuffer: async (key: string) =>
      Buffer.from(h.blobs.get(key) ?? "", "utf-8"),
  },
}));

vi.mock("../../utils/permission-check.js", async () => {
  const { db } = await import("@synap/database");
  const { resolveGovernanceRule } =
    await import("@synap/database/agent-governance");
  const { decideAgentPolicy } = await import("@synap/governance-policy");
  return {
    checkPermissionOrPropose: async (opts: {
      agentUserId?: string;
      workspaceId?: string;
      subjectType: string;
      action: string;
    }) => {
      h.gateActions.push(opts.action);
      if (!opts.agentUserId) return { granted: true };
      const rule = await resolveGovernanceRule({
        db: db as never,
        agentUserId: opts.agentUserId,
        workspaceId: opts.workspaceId ?? null,
        subjectType: opts.subjectType,
        action: opts.action,
      });
      const verdict = decideAgentPolicy({
        subjectType: opts.subjectType,
        action: opts.action,
        governanceRuleVerdict: rule?.verdict,
      });
      return verdict.verdict === "execute"
        ? { granted: true }
        : {
            granted: false,
            proposalId: "prop-1",
            proposalType: `${opts.subjectType}.${opts.action}`,
            summary: "s",
            reasoning: "r",
            reviewPath: "/open/prop-1",
            reviewUrl: "https://pod/open/prop-1",
          };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  documents,
  documentVersions,
  focusSessions,
  artifacts,
  governanceRules,
} from "@synap/database/schema";
import {
  upsertSessionDocumentSection,
  readSessionDocument,
} from "./upsert-section.js";
import { applyApprovedDocumentPatch } from "../document-patch/apply-document-patch.js";
import { ensureSessionNarrativeRule } from "./ensure-narrative-rule.js";
import { SESSION_DOCUMENT_LABEL } from "./session-document.js";

const USER = "user-1";
const AGENT = "agent-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  // A Postgres array column (`text[]`) with a JS array default is an array
  // literal, not jsonb — `'[]'::jsonb` on `focus_sessions.agent_ids` fails DDL.
  if (Array.isArray(d) && type.endsWith("[]")) {
    return ` default '{${d.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")}}'`;
  }
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function newSession(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata) values ($1, $2, 'Find leads', 'active', '{}'::jsonb)`,
    [id, USER]
  );
  return id;
}

async function currentVersion(documentId: string): Promise<number> {
  const { rows } = await q<{ current_version: number }>(
    `select current_version from documents where id = $1`,
    [documentId]
  );
  return rows[0]!.current_version;
}

async function versionRowCount(documentId: string): Promise<number> {
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from document_versions where document_id = $1`,
    [documentId]
  );
  return rows[0]!.n;
}

async function storedContent(documentId: string): Promise<string> {
  const { rows } = await q<{ storage_key: string }>(
    `select storage_key from documents where id = $1`,
    [documentId]
  );
  return h.blobs.get(rows[0]!.storage_key) ?? "";
}

beforeAll(async () => {
  for (const table of [
    documents,
    documentVersions,
    focusSessions,
    artifacts,
    governanceRules,
  ]) {
    await h.client!.exec(ddlFor(table as PgTable));
  }
});

beforeEach(async () => {
  h.gateActions.length = 0;
  await q(`delete from governance_rules`);
  await ensureSessionNarrativeRule();
});

/** A session whose document has a human "why" section (v2) and an AI "approach" section (v3). */
async function seededSession() {
  const sessionId = await newSession();
  const human = await upsertSessionDocumentSection({
    userId: USER,
    sessionId,
    sectionId: "why",
    title: "Why",
    body: "Because the founder asked.",
    baseVersion: null,
  });
  if (human.status !== "applied") throw new Error("seed failed");
  const ai = await upsertSessionDocumentSection({
    userId: USER,
    agentUserId: AGENT,
    sessionId,
    ambientSessionId: sessionId,
    sectionId: "approach",
    title: "Approach",
    body: "Draft one.",
    baseVersion: human.version,
  });
  if (ai.status !== "applied") throw new Error("seed failed");
  return { sessionId, documentId: ai.documentId, version: ai.version };
}

describe("designation", () => {
  it("the first write creates ONE document, designated by the reserved label", async () => {
    const sessionId = await newSession();
    const result = await upsertSessionDocumentSection({
      userId: USER,
      agentUserId: AGENT,
      sessionId,
      ambientSessionId: sessionId,
      sectionId: "approach",
      title: "Approach",
      body: "Cold outreach.",
      baseVersion: null,
    });
    expect(result).toMatchObject({ status: "applied", version: 2 });
    const { rows } = await q<{ ref_id: string; label: string }>(
      `select ref_id, props->>'expectedLabel' as label from artifacts where session_id = $1`,
      [sessionId]
    );
    expect(rows).toEqual([
      { ref_id: result.documentId, label: SESSION_DOCUMENT_LABEL },
    ]);

    const read = await readSessionDocument({ sessionId, userId: USER });
    expect(read).toMatchObject({ documentId: result.documentId, version: 2 });
    expect(read.sections).toEqual([
      {
        id: "approach",
        owner: "ai",
        author: AGENT,
        writtenAt: expect.any(String),
        sessionState: "active",
      },
    ]);
  });

  it("another user's session is NOT_FOUND", async () => {
    const sessionId = await newSession();
    await expect(
      upsertSessionDocumentSection({
        userId: "someone-else",
        sessionId,
        sectionId: "why",
        title: "Why",
        body: "x",
        baseVersion: null,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("section writes", () => {
  it("replaces ONLY its section — the human section is byte-identical", async () => {
    const { sessionId, documentId, version } = await seededSession();
    const before = await storedContent(documentId);
    const humanBlock = before.slice(0, before.indexOf("::::\n") + 4);

    const result = await upsertSessionDocumentSection({
      userId: USER,
      agentUserId: AGENT,
      sessionId,
      ambientSessionId: sessionId,
      sectionId: "approach",
      title: "Approach",
      body: "Draft two.",
      baseVersion: version,
    });
    expect(result).toMatchObject({ status: "applied", replaced: true });
    const after = await storedContent(documentId);
    expect(after.startsWith(humanBlock)).toBe(true);
    expect(after).toContain("Draft two.");
    expect(after).not.toContain("Draft one.");
    const read = await readSessionDocument({ sessionId, userId: USER });
    expect(read.sections.map((s) => [s.id, s.owner])).toEqual([
      ["why", "human"],
      ["approach", "ai"],
    ]);
  });

  it("REFUSES an agent rewrite of a human-owned section, and writes nothing", async () => {
    const { sessionId, documentId, version } = await seededSession();
    const rowsBefore = await versionRowCount(documentId);
    await expect(
      upsertSessionDocumentSection({
        userId: USER,
        agentUserId: AGENT,
        sessionId,
        ambientSessionId: sessionId,
        sectionId: "why",
        title: "Why",
        body: "The AI's opinion.",
        baseVersion: version,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await currentVersion(documentId)).toBe(version);
    expect(await versionRowCount(documentId)).toBe(rowsBefore);
    expect(await storedContent(documentId)).toContain(
      "Because the founder asked."
    );
  });

  it("REFUSES a stale base version, and writes nothing", async () => {
    const { sessionId, documentId, version } = await seededSession();
    await expect(
      upsertSessionDocumentSection({
        userId: USER,
        agentUserId: AGENT,
        sessionId,
        ambientSessionId: sessionId,
        sectionId: "decisions",
        title: "Decisions",
        body: "Go.",
        baseVersion: version - 1,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await currentVersion(documentId)).toBe(version);
    expect(await storedContent(documentId)).not.toContain("Go.");
  });
});

describe("governance (D10)", () => {
  it("own session's document → session_narrative_update → the seeded rule applies it", async () => {
    const { sessionId, version } = await seededSession();
    h.gateActions.length = 0;
    const result = await upsertSessionDocumentSection({
      userId: USER,
      agentUserId: AGENT,
      sessionId,
      ambientSessionId: sessionId,
      sectionId: "decisions",
      title: "Decisions",
      body: "Go.",
      baseVersion: version,
    });
    expect(h.gateActions).toEqual(["session_narrative_update"]);
    expect(result.status).toBe("applied");
  });

  it("ANOTHER session's document → section_update → proposed, document untouched", async () => {
    const { sessionId, documentId, version } = await seededSession();
    const elsewhere = await newSession();
    h.gateActions.length = 0;
    const result = await upsertSessionDocumentSection({
      userId: USER,
      agentUserId: AGENT,
      sessionId,
      ambientSessionId: elsewhere,
      sectionId: "decisions",
      title: "Decisions",
      body: "Go.",
      baseVersion: version,
    });
    expect(h.gateActions).toEqual(["section_update"]);
    expect(result).toMatchObject({ status: "proposed", proposalId: "prop-1" });
    expect(await currentVersion(documentId)).toBe(version);
  });

  it("no ambient session at all is NOT the own session → proposed", async () => {
    const { sessionId, version } = await seededSession();
    const result = await upsertSessionDocumentSection({
      userId: USER,
      agentUserId: AGENT,
      sessionId,
      sectionId: "decisions",
      title: "Decisions",
      body: "Go.",
      baseVersion: version,
    });
    expect(result.status).toBe("proposed");
  });

  it("with the rule REVOKED, even the own session's write is proposed (the rule is the only widening)", async () => {
    const { sessionId, version } = await seededSession();
    await q(`update governance_rules set revoked_at = now()`);
    const result = await upsertSessionDocumentSection({
      userId: USER,
      agentUserId: AGENT,
      sessionId,
      ambientSessionId: sessionId,
      sectionId: "decisions",
      title: "Decisions",
      body: "Go.",
      baseVersion: version,
    });
    expect(result.status).toBe("proposed");
  });
});

describe("undo", () => {
  it("returns a version row holding the exact pre-write content, restorable by restoreVersion's own checks", async () => {
    const { sessionId, documentId, version } = await seededSession();
    const before = await storedContent(documentId);
    const result = await upsertSessionDocumentSection({
      userId: USER,
      agentUserId: AGENT,
      sessionId,
      ambientSessionId: sessionId,
      sectionId: "approach",
      title: "Approach",
      body: "Draft two.",
      baseVersion: version,
    });
    if (result.status !== "applied") throw new Error("expected applied");

    const { rows } = await q<{
      document_id: string;
      version: number;
      storage_key: string;
    }>(
      `select document_id, version, storage_key from document_versions where id = $1`,
      [result.undo.versionId]
    );
    // `documents.restoreVersion` requires: the version belongs to the document,
    // and the document belongs to the caller.
    expect(rows[0]).toMatchObject({ document_id: documentId, version });
    const { rows: owner } = await q<{ user_id: string }>(
      `select user_id from documents where id = $1`,
      [documentId]
    );
    expect(owner[0]!.user_id).toBe(USER);
    expect(h.blobs.get(rows[0]!.storage_key)).toBe(before);
    expect(await storedContent(documentId)).not.toBe(before);
  });
});

describe("approval half", () => {
  it("applies a proposed section at approval, and refuses once the document moved", async () => {
    const { sessionId, documentId, version } = await seededSession();
    const draft = {
      documentId,
      sessionId,
      sectionId: "decisions",
      title: "Decisions",
      body: "Approved text.",
      attributes: {
        owner: "ai" as const,
        author: AGENT,
        writtenAt: "2026-09-14T00:00:00.000Z",
        sessionState: "active",
      },
      baseVersion: version,
    };

    const applied = await applyApprovedDocumentPatch(
      { targetId: documentId, agentUserId: AGENT, data: { data: draft } },
      USER
    );
    expect(applied.version).toBe(version + 1);
    expect(await storedContent(documentId)).toContain("Approved text.");

    await expect(
      applyApprovedDocumentPatch(
        { targetId: documentId, agentUserId: AGENT, data: draft },
        USER
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
