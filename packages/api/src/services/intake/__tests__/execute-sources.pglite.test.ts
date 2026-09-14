/**
 * THE RAW CAPTURE IS ALWAYS KEPT — `capture.execute`'s raw door and the
 * `keepRaw: false` retention rule, on a real Postgres (PGlite).
 *
 * stageExecuteSources (real) → stageCaptureSources (real) → stageIntakeSource
 * (real, through the real `DocumentRepository` / `stageSourceBlob`) →
 * recordSessionRunManifest (real SQL). `recordStructureIntake` (real) plays the
 * structure half. Every assertion reads the rows back.
 *
 * Stubbed, and why (same as `intake-run.pglite.test.ts`): `@synap/storage`
 * (in-memory upload), `eventRepository.append` (post-commit fan-out).
 *
 * NOT covered here: that `capture.execute` calls this door before its receipt
 * and proposals and forwards the ids — pinned by
 * `__tripwires__/capture-doors-stage-raw.test.ts` (the procedure needs
 * governance, materialize and search to run end to end).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  uploads: 0,
}));

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (userId: string, kind: string, id: string, ext: string) =>
      `${userId}/${kind}/${id}.${ext}`,
    upload: async (key: string, body: Buffer | string) => {
      h.uploads += 1;
      return { url: `mem://${key}`, path: key, size: Buffer.byteLength(body) };
    },
    delete: async () => undefined,
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client),
    eventRepository: { append: async () => undefined },
  };
});

import { db } from "@synap/database";
import {
  EXECUTE_SOURCE_DOOR,
  renderExecutePlanText,
  stageExecuteSources,
} from "../stage-execute-sources.js";
import {
  capturePlanKey,
  recordStructureIntake,
} from "../record-structure-intake.js";
import { readSessionRunManifest } from "../record-session-run-manifest.js";

const USER = "user-1";

const DDL = `
  create table focus_sessions (
    id uuid primary key default gen_random_uuid(), user_id text not null,
    goal text not null default '', status text not null default 'active',
    workspace_id text, origin text, playbook_id uuid,
    metadata jsonb not null default '{}'::jsonb
  );
  create table documents (
    id uuid primary key default gen_random_uuid(), user_id text not null,
    workspace_id uuid, title text not null, type text not null, language text,
    storage_url text, storage_key text, size integer not null default 0,
    mime_type text, current_version integer not null default 1,
    last_saved_version integer not null default 0, working_state text,
    working_state_updated_at timestamptz, metadata jsonb,
    created_by_kind text, created_by_user_id text, agent_user_id text,
    source_proposal_id uuid, correlation_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(), deleted_at timestamptz
  );
  create table document_versions (
    id uuid primary key default gen_random_uuid(),
    document_id uuid not null references documents(id) on delete cascade,
    version integer not null, content text not null, storage_url text,
    storage_key text, size integer not null default 0, mime_type text,
    checksum text, author text not null, author_id text not null,
    message text, created_at timestamptz not null default now()
  );
`;

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

type SourceRow = {
  id: string;
  mime_type: string | null;
  metadata: { intakeSource: Record<string, unknown> };
};

const sourcesOf = async (sessionId: string) =>
  (
    await q<SourceRow>(
      `select id, mime_type, metadata from documents
        where metadata #>> '{intakeSource,sessionId}' = $1 order by created_at`,
      [sessionId]
    )
  ).rows;

const manifestOf = async (sessionId: string) => {
  const { rows } = await q<{ metadata: unknown }>(
    `select metadata from focus_sessions where id = $1`,
    [sessionId]
  );
  return readSessionRunManifest(rows[0]!.metadata);
};

async function newSession(): Promise<string> {
  const { rows } = await q<{ id: string }>(
    `insert into focus_sessions (user_id, goal) values ($1, 'Capture') returning id`,
    [USER]
  );
  return rows[0]!.id;
}

const PLAN = [
  {
    tempId: "t1",
    profileSlug: "task",
    title: "Call Dana about the lease",
    description: "before Friday",
    properties: { due: "2026-09-18" },
  },
];
const PLAN_KEY = capturePlanKey(PLAN, [])!;

const structure = (
  sessionId: string,
  over: Partial<Parameters<typeof recordStructureIntake>[0]> = {}
) =>
  recordStructureIntake({
    database: db,
    userId: USER,
    workspaceId: null,
    ensuredSession: {
      status: "provided",
      sessionId,
      requestedSessionId: sessionId,
      requestedSessionIgnored: false,
    },
    source: { text: "call dana about the lease before friday" },
    guidelines: [],
    runFacts: {
      engine: "structure",
      model: "m",
      provider: "p",
      promptVersion: "v",
    },
    planKey: PLAN_KEY,
    ...over,
  });

const execute = (
  sessionId: string | null,
  over: Partial<Parameters<typeof stageExecuteSources>[0]> = {}
) =>
  stageExecuteSources({
    database: db,
    userId: USER,
    workspaceId: null,
    sessionId,
    planKey: PLAN_KEY,
    entities: PLAN,
    ...over,
  });

beforeAll(async () => {
  await h.client!.exec(DDL);
});

beforeEach(async () => {
  await h.client!.exec(
    `delete from document_versions; delete from documents; delete from focus_sessions;`
  );
  h.uploads = 0;
});

describe("capture.execute with no structure call", () => {
  it("keeps the plan it RECEIVED as its raw, through the one raw door, and records it on the run", async () => {
    const sessionId = await newSession();
    const out = await execute(sessionId);

    expect(out.origin).toBe("staged");
    expect(out.errors).toEqual([]);
    const rows = await sourcesOf(sessionId);
    expect(rows).toHaveLength(1);
    expect(out.sourceDocumentIds).toEqual([rows[0]!.id]);
    expect(rows[0]!.metadata.intakeSource).toMatchObject({
      kind: "text",
      door: EXECUTE_SOURCE_DOOR,
      sessionId,
      planKeys: [PLAN_KEY],
    });
    const { rows: body } = await q<{ content: string }>(
      `select content from document_versions where document_id = $1`,
      [rows[0]!.id]
    );
    expect(body[0]!.content).toBe(renderExecutePlanText(PLAN));
    expect(body[0]!.content).toContain("Call Dana about the lease");
    expect(body[0]!.content).toContain("- due: 2026-09-18");
    expect((await manifestOf(sessionId))!.sourceDocumentIds).toEqual([
      rows[0]!.id,
    ]);
  });

  it("a retry of the same execute keeps ONE raw, and then reads it as the run's", async () => {
    const sessionId = await newSession();
    const first = await execute(sessionId);
    const retry = await execute(sessionId);
    expect(retry.origin).toBe("run");
    expect(retry.sourceDocumentIds).toEqual(first.sourceDocumentIds);
    expect(await sourcesOf(sessionId)).toHaveLength(1);
  });

  it("with no room at all (mint failed) the raw is still kept, unattached", async () => {
    const out = await execute(null);
    expect(out.origin).toBe("staged");
    expect(out.sourceDocumentIds).toHaveLength(1);
    const { rows } = await q<SourceRow>(
      `select id, mime_type, metadata from documents where id = $1`,
      [out.sourceDocumentIds[0]]
    );
    expect(rows[0]!.metadata.intakeSource).toMatchObject({
      door: EXECUTE_SOURCE_DOOR,
      sessionId: null,
    });
  });
});

describe("capture.execute of a plan structure already staged", () => {
  it("reuses structure's raw for THAT plan and stages nothing", async () => {
    const sessionId = await newSession();
    const echo = await structure(sessionId);
    expect(echo.intake.sourceDocumentIds).toHaveLength(1);

    const out = await execute(sessionId);
    expect(out.origin).toBe("run");
    expect(out.sourceDocumentIds).toEqual(echo.intake.sourceDocumentIds);
    expect(await sourcesOf(sessionId)).toHaveLength(1);
  });

  it("a clarification re-structure of the SAME raw appends its plan key, so that plan's execute finds the raw too", async () => {
    const sessionId = await newSession();
    const refined = capturePlanKey(
      [{ ...PLAN[0]!, title: "Call Dana (lease renewal)" }],
      []
    )!;
    const first = await structure(sessionId);
    const second = await structure(sessionId, { planKey: refined });
    expect(second.intake.sourceDocumentIds).toEqual(
      first.intake.sourceDocumentIds
    );
    const [row] = await sourcesOf(sessionId);
    expect(row!.metadata.intakeSource.planKeys).toEqual([PLAN_KEY, refined]);

    const out = await execute(sessionId, { planKey: refined });
    expect(out.origin).toBe("run");
    expect(out.sourceDocumentIds).toEqual(first.intake.sourceDocumentIds);
  });

  it("the SESSION alone is not the match: another capture's raw in the same session is not this plan's", async () => {
    // A person's own session receives many captures.
    const sessionId = await newSession();
    const other = await structure(sessionId, {
      source: { text: "buy milk" },
      planKey: capturePlanKey(
        [{ tempId: "m", profileSlug: "task", title: "Buy milk" }],
        []
      ),
    });

    const out = await execute(sessionId);
    expect(out.origin).toBe("staged");
    expect(out.sourceDocumentIds).toHaveLength(1);
    expect(out.sourceDocumentIds).not.toContain(
      other.intake.sourceDocumentIds[0]
    );
    expect(await sourcesOf(sessionId)).toHaveLength(2);
  });

  it("a FAILED run-source read is named, and the raw is staged anyway — never read as 'no source'", async () => {
    const sessionId = await newSession();
    await structure(sessionId);
    let selects = 0;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select" && selects++ === 0) {
          return () => {
            throw new Error("read timeout");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    const out = await execute(sessionId, { database: flaky });
    expect(out.errors).toEqual(["run sources: read timeout"]);
    expect(out.origin).toBe("staged");
    expect(out.sourceDocumentIds).toHaveLength(1);
  });
});

describe("a file execute receives", () => {
  const png = () => Buffer.from(`\x89PNG-bytes-${Math.random()}`);

  it("keepRaw: true keeps the ORIGINAL bytes and hands them back as the blob execute links — one upload, not two", async () => {
    const sessionId = await newSession();
    const bytes = png();
    const out = await execute(sessionId, {
      entities: [],
      planKey: undefined,
      keepRaw: true,
      file: {
        content: bytes.toString("base64"),
        mimeType: "image/png",
        filename: "lease.png",
        extractedText: "LEASE",
      },
    });
    const rows = await sourcesOf(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mime_type).toBe("image/png");
    expect(out.fileBlob).toMatchObject({
      documentId: rows[0]!.id,
      mimeType: "image/png",
    });
    expect(h.uploads).toBe(1);
  });

  it("keepRaw: false on a file NOTHING read keeps the bytes anyway, marked retainedUntilStructured", async () => {
    const sessionId = await newSession();
    await execute(sessionId, {
      entities: [],
      planKey: undefined,
      keepRaw: false,
      file: { content: png().toString("base64"), mimeType: "image/png" },
    });
    const [row] = await sourcesOf(sessionId);
    expect(row!.mime_type).toBe("image/png");
    expect(row!.metadata.intakeSource.retainedUntilStructured).toBe(true);
  });
});

describe("keepRaw: false + a DEGRADED structure (the relay 'extract text only' toggle)", () => {
  it("keeps the photo's bytes until it is structured, and the echo says so", async () => {
    const sessionId = await newSession();
    const echo = await structure(sessionId, {
      source: {
        file: {
          content: Buffer.from("\x89PNG-degraded").toString("base64"),
          mimeType: "image/png",
          filename: "receipt.png",
        },
      },
      keepRaw: false,
      degraded: { reason: "spend_guard" },
      planKey: undefined,
    });
    expect(echo.intake.degradedSourceKept).toBe(true);
    expect(echo.intake.originalRetainedUntilStructured).toBe(true);
    const [row] = await sourcesOf(sessionId);
    expect(row!.mime_type).toBe("image/png");
    expect(row!.metadata.intakeSource).toMatchObject({
      kind: "file",
      retainedUntilStructured: true,
      degraded: { reason: "spend_guard" },
    });
  });

  it("a file that WAS read honours 'text only': no bytes, no retention marker", async () => {
    const sessionId = await newSession();
    await structure(sessionId, {
      source: {
        file: {
          content: Buffer.from("\x89PNG-read").toString("base64"),
          mimeType: "image/png",
        },
      },
      extractedText: "TOTAL 12.40",
      keepRaw: false,
      planKey: undefined,
    });
    const [row] = await sourcesOf(sessionId);
    expect(row!.mime_type).toBe("text/markdown");
    expect(row!.metadata.intakeSource.retainedUntilStructured).toBeUndefined();
  });
});
