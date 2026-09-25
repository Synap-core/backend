/**
 * The closing report, driven END TO END on PGlite from the close event.
 *
 * Real: `closingReportReactor.handler` → `writeClosingReport` → the session
 * row, `loadSessionEvaluationSummary` (real `session_evaluations` rows, human
 * wins), `listSessionOutputs` (real artifacts + produced links), the decided-
 * proposal read, and the ONE section door `upsertSessionDocumentSection`
 * (designation, base version, ownership refusal, compare-and-set version
 * write) — then the outcome stamp on `focus_sessions.metadata`.
 *
 * Stubbed, and why (same harness as `upsert-section.pglite.test.ts`):
 *  - `checkPermissionOrPropose` — records the principal and grants; the system
 *    writer runs on the OWNER's principal (no agent id), and that is asserted.
 *  - `@synap/storage` + `uploadDocumentVersionSnapshot` — an in-memory blob
 *    map (a switch makes uploads throw for the failure case).
 *  - `DocumentRepository` — writes the document + v1 rows straight to PGlite.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blobs: new Map<string, string>(),
  gateCalls: [] as Array<{ agentUserId?: string; userId: string }>,
  failUploads: false,
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
    // `recordSessionArtifact` reads `db.query.focusSessions` (relational API).
    db: drizzle(client, {
      schema: { focusSessions: schema.focusSessions } as never,
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
      if (h.failUploads) throw new Error("storage is down");
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

vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: {
    agentUserId?: string;
    userId: string;
  }) => {
    h.gateCalls.push({ agentUserId: opts.agentUserId, userId: opts.userId });
    return { granted: true };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  documents,
  documentVersions,
  focusSessions,
  artifacts,
  proposals,
  sessionEvaluations,
  links,
  entities,
  views,
  automations,
  playbooks,
} from "@synap/database/schema";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_CLOSE_ACTION,
} from "../focus-sessions/close-event.js";
import { closingReportReactor } from "./closing-report-reactor.js";
import {
  upsertSessionDocumentSection,
  readSessionDocument,
} from "./upsert-section.js";
import { parseSections, sectionOwner } from "./sections.js";
import {
  CLOSING_REPORT_AUTHOR,
  CLOSING_REPORT_SECTION_IDS,
} from "./closing-report.js";

const USER = "user-1";
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
  if (Array.isArray(d) && type.endsWith("[]")) return " default '{}'";
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

const CRITERIA = [
  {
    key: "tsc",
    statement: "Typecheck passes",
    check: { kind: "evidence", evidenceKey: "tsc" },
  },
  { key: "copy", statement: "Copy reads well", check: { kind: "judge" } },
];

async function newSession(opts: {
  metadata?: Record<string, unknown>;
  criteria?: unknown[];
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, origin, metadata, criteria, verification_report)
     values ($1, $2, 'Ship the toggle', $3, 'human', $4::jsonb, $5::jsonb, $6::jsonb)`,
    [
      id,
      USER,
      opts.status ?? "closed",
      JSON.stringify(opts.metadata ?? {}),
      JSON.stringify(opts.criteria ?? []),
      JSON.stringify({ summary: "Shipped the toggle." }),
    ]
  );
  return id;
}

async function evaluate(
  sessionId: string,
  key: string,
  verdict: string,
  kind: string,
  id: string
) {
  await q(
    `insert into session_evaluations (session_id, user_id, criterion_key, verdict, evaluator_kind, evaluator_id, rationale)
     values ($1, $2, $3, $4, $5, $6, 'because')`,
    [sessionId, USER, key, verdict, kind, id]
  );
}

async function produceEntity(sessionId: string): Promise<string> {
  const entityId = randomUUID();
  await q(
    `insert into links (id, created_by, from_type, from_id, to_type, to_id, link_type)
     values ($1, $2, 'session', $3, 'entity', $4, 'produced')`,
    [randomUUID(), USER, sessionId, entityId]
  );
  return entityId;
}

async function decide(sessionId: string, status: string, name: string) {
  await q(
    `insert into proposals (id, target_type, target_id, proposal_type, status, data, session_id, reviewed_at)
     values ($1, 'entity', $2, 'create', $3, $4::jsonb, $5, now())`,
    [
      randomUUID(),
      randomUUID(),
      status,
      JSON.stringify({ targetName: name }),
      sessionId,
    ]
  );
}

const close = (sessionId: string) =>
  closingReportReactor.handler(
    {
      subjectType: FOCUS_SESSION_SUBJECT_TYPE,
      action: FOCUS_SESSION_CLOSE_ACTION,
      subjectId: sessionId,
      userId: USER,
      data: { sessionId },
    } as never,
    {} as never
  );

async function doc(sessionId: string) {
  return readSessionDocument({ sessionId, userId: USER });
}

async function metadata(sessionId: string): Promise<Record<string, any>> {
  const { rows } = await q<{ metadata: Record<string, any> }>(
    `select metadata from focus_sessions where id = $1`,
    [sessionId]
  );
  return rows[0]!.metadata;
}

beforeAll(async () => {
  for (const table of [
    documents,
    documentVersions,
    focusSessions,
    artifacts,
    proposals,
    sessionEvaluations,
    links,
    entities,
    views,
    automations,
    playbooks,
  ]) {
    await h.client!.exec(ddlFor(table as PgTable));
  }
});

beforeEach(() => {
  h.gateCalls.length = 0;
  h.failUploads = false;
});

describe("closing report — close event → session document", () => {
  it("writes the four structured sections from stored facts, as the system on the owner's principal", async () => {
    const id = await newSession({ criteria: CRITERIA });
    await evaluate(id, "tsc", "pass", "evidence", "agent-9");
    await evaluate(id, "copy", "fail", "judge", "model-x");
    const entityId = await produceEntity(id);
    await decide(id, "approved", "Ship toggle");
    await decide(id, "rejected", "Old note");
    await decide(id, "pending", "Still waiting");

    await close(id);

    const d = await doc(id);
    const parsed = parseSections(d.content!);
    expect(parsed.sections.map((s) => s.id)).toEqual(
      Object.values(CLOSING_REPORT_SECTION_IDS)
    );
    for (const s of parsed.sections) {
      expect(sectionOwner(s)).toBe("ai");
      expect(s.attributes.author).toBe(CLOSING_REPORT_AUTHOR);
    }
    expect(parsed.sections[1]!.attributes.status).toBe("failing");
    expect(d.content).toContain(
      "**Closed** · 1 required criterion unmet (1 of 2 passed)"
    );
    expect(d.content).toContain("Shipped the toggle.");
    expect(d.content).toContain(
      "| Copy reads well | Failed | Judge (model-x) | because |"
    );
    expect(d.content).toContain(`:::synap-entity{id="${entityId}"}`);
    expect(d.content).toContain("2 proposals decided."); // pending is not a decision
    expect(d.content).toContain("— Rejected");
    // The session document is not listed as something the session produced.
    expect(d.content).not.toMatch(/- Document:/);
    // Governance ran on the owner's principal — never an invented agent id.
    expect(h.gateCalls.length).toBe(4);
    for (const c of h.gateCalls)
      expect(c).toEqual({ agentUserId: undefined, userId: USER });

    const m = await metadata(id);
    expect(m.closingReport.status).toBe("written");
    expect(m.closingReport.documentId).toBe(d.documentId);
  });

  it("IDEMPOTENT: a second delivery of the same close writes nothing (no version churn)", async () => {
    const id = await newSession({ criteria: CRITERIA });
    await evaluate(id, "tsc", "pass", "evidence", "agent-9");
    await close(id);
    const first = await doc(id);
    // Non-vacuity: two "no document" reads would also compare equal.
    expect(first.documentId).not.toBeNull();
    expect(first.version).toBeGreaterThan(1);
    h.gateCalls.length = 0;

    await close(id);

    const second = await doc(id);
    expect(second.version).toBe(first.version);
    expect(second.content).toBe(first.content);
    expect(h.gateCalls).toHaveLength(0);
  });

  it("reopen → regrade → close rewrites the SAME sections in place, never appends", async () => {
    const id = await newSession({ criteria: CRITERIA });
    await evaluate(id, "tsc", "pass", "evidence", "agent-9");
    await evaluate(id, "copy", "fail", "judge", "model-x");
    await close(id);
    const before = await doc(id);

    // A person overrides the judge; the session is closed again.
    await evaluate(id, "copy", "pass", "human", USER);
    await close(id);

    const after = await doc(id);
    const parsed = parseSections(after.content!);
    expect(parsed.duplicateIds).toEqual([]);
    expect(parsed.sections).toHaveLength(4);
    expect(parsed.sections[1]!.attributes.status).toBe("passing");
    expect(after.content).toContain(
      "| Copy reads well | Passed | Human | because |"
    );
    // Only the sections whose facts changed were rewritten.
    expect(after.version! - before.version!).toBe(2); // outcome + definition of done
  });

  it("a section a PERSON wrote is left untouched; the rest are refreshed", async () => {
    const id = await newSession({ criteria: CRITERIA });
    await close(id);
    const d = await doc(id);
    // A person rewrites the outcome section (human writer ⇒ owner="human").
    await upsertSessionDocumentSection({
      userId: USER,
      sessionId: id,
      sectionId: CLOSING_REPORT_SECTION_IDS.outcome,
      title: "Outcome",
      body: "In my own words.",
      baseVersion: d.version,
    });
    await evaluate(id, "tsc", "pass", "evidence", "agent-9");

    await close(id);

    const after = await doc(id);
    const outcome = parseSections(after.content!).sections.find(
      (s) => s.id === CLOSING_REPORT_SECTION_IDS.outcome
    )!;
    expect(sectionOwner(outcome)).toBe("human");
    expect(after.content).toContain("In my own words.");
    expect(after.content).toContain(
      "| Typecheck passes | Passed | Evidence | because |"
    );
    expect((await metadata(id)).closingReport.keptHuman).toEqual([
      CLOSING_REPORT_SECTION_IDS.outcome,
    ]);
  });

  it("a receipt gets no report and no stamp, even with outputs and criteria", async () => {
    const id = await newSession({
      criteria: CRITERIA,
      metadata: { kind: "agent-proposal-package" },
    });
    await produceEntity(id);
    await close(id);
    expect((await doc(id)).documentId).toBeNull();
    expect((await metadata(id)).closingReport).toBeUndefined();
  });

  it("a session with no criteria and no outputs gets nothing", async () => {
    const id = await newSession({});
    await close(id);
    expect((await doc(id)).documentId).toBeNull();
    expect((await metadata(id)).closingReport).toBeUndefined();
  });

  it("a FAILED write is recorded on the session, never reported as written", async () => {
    const id = await newSession({ criteria: CRITERIA });
    h.failUploads = true;
    await expect(close(id)).resolves.toBeUndefined();
    const m = await metadata(id);
    expect(m.closingReport.status).toBe("failed");
    expect(m.closingReport.reason).toMatch(/storage is down/);
  });
});
