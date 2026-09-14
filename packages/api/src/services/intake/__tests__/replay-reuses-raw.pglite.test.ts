/**
 * A REPLAY NEVER COPIES ITS RAW — rerun / structure again name the stored raw
 * (`reuseDocumentId`) and staging reuses that row, on a real Postgres (PGlite).
 *
 * Drives the exact staging calls a replay makes into its CHILD session:
 *   capture — `recordStructureIntake` (what `capture.structure`'s `finishIntake`
 *             calls, the child handed as a verified session) →
 *             `stageCaptureSources` → `stageIntakeSource`;
 *   import  — `recordImportIntake` (what `ImportOrchestrator.analyze` calls).
 * Every assertion reads the rows back.
 *
 * Stubbed: `@synap/storage` (in-memory upload), `eventRepository.append`.
 *
 * NOT covered here: that the replayers hand the id to those doors
 * (`rerun-replay-names-raw.test.ts`), and that `capture.structure` forwards its
 * `sourceDocumentId` input (source-pinned by that test too).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (userId: string, kind: string, id: string, ext: string) =>
      `${userId}/${kind}/${id}.${ext}`,
    upload: async (key: string, body: Buffer | string) => ({
      url: `mem://${key}`,
      path: key,
      size: Buffer.byteLength(body),
    }),
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
import { recordStructureIntake } from "../record-structure-intake.js";
import { recordImportIntake } from "../record-import-intake.js";
import { readSessionRunManifest } from "../record-session-run-manifest.js";

const USER = "user-1";
const OTHER = "user-2";
const TEXT = "call dana about the lease";

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

async function newSession(userId = USER): Promise<string> {
  const { rows } = await q<{ id: string }>(
    `insert into focus_sessions (user_id, goal) values ($1, 'Run') returning id`,
    [userId]
  );
  return rows[0]!.id;
}

const intakeRows = async (userId = USER) =>
  (
    await q<{
      id: string;
      metadata: { intakeSource: Record<string, unknown> };
    }>(
      `select id, metadata from documents
        where user_id = $1 and metadata ? 'intakeSource' and deleted_at is null
        order by created_at`,
      [userId]
    )
  ).rows;

const manifestOf = async (sessionId: string) =>
  readSessionRunManifest(
    (
      await q<{ metadata: unknown }>(
        `select metadata from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!.metadata
  );

const structureInto = (
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
    source: { text: TEXT },
    guidelines: [],
    runFacts: {
      engine: "structure",
      model: "m",
      provider: "p",
      promptVersion: "v",
    },
    ...over,
  });

const ITEM = { path: "notes/lease.md", content: "# Lease\nCall Dana" };

const importInto = (
  sessionId: string,
  items: Parameters<typeof recordImportIntake>[0]["items"] = [ITEM]
) =>
  recordImportIntake({
    database: db,
    userId: USER,
    workspaceId: null,
    sessionId,
    source: "markdown",
    items,
    run: {},
  });

beforeAll(async () => {
  await h.client!.exec(DDL);
});
beforeEach(async () => {
  await h.client!.exec(
    "delete from document_versions; delete from documents; delete from focus_sessions;"
  );
});

describe("a replay reuses its stored raw", () => {
  it("CONTROL: without the reuse id, the child session stages a second copy (the defect this closes)", async () => {
    await structureInto(await newSession());
    await structureInto(await newSession());
    expect(await intakeRows()).toHaveLength(2);
  });

  it("capture: one raw row; the child run names the ORIGINAL; degraded cleared on it", async () => {
    const parent = await newSession();
    const first = await structureInto(parent, {
      degraded: { reason: "spend_guard" },
    });
    const original = first.intake.sourceDocumentIds[0]!;

    const child = await newSession();
    const replay = await structureInto(child, {
      reuseSourceDocumentId: original,
    });

    const rows = await intakeRows();
    expect(rows.map((r) => r.id)).toEqual([original]);
    expect(replay.intake.sourceDocumentIds).toEqual([original]);
    expect(replay.intake.errors).toBeUndefined();
    expect((await manifestOf(child))!.sourceDocumentIds).toEqual([original]);
    // The raw still belongs to its first run; the child only lists it.
    expect(rows[0]!.metadata.intakeSource.sessionId).toBe(parent);
    expect(rows[0]!.metadata.intakeSource.degraded).toBeUndefined();
    expect(rows[0]!.metadata.intakeSource.restructuredAt).toEqual(
      expect.any(String)
    );
  });

  it("capture: the same raw sent in another form (long text as a .md file) still reuses the row", async () => {
    const first = await structureInto(await newSession());
    const original = first.intake.sourceDocumentIds[0]!;
    await structureInto(await newSession(), {
      source: {
        file: {
          content: TEXT,
          mimeType: "text/markdown",
          filename: "note.md",
          encoding: "utf8",
        },
      },
      extractedText: TEXT,
      reuseSourceDocumentId: original,
    });
    expect((await intakeRows()).map((r) => r.id)).toEqual([original]);
  });

  it("capture: a foreign or deleted reuse id is NAMED, stages nothing, and never crashes the call", async () => {
    const foreign = await recordStructureIntake({
      database: db,
      userId: OTHER,
      workspaceId: null,
      ensuredSession: {
        status: "provided",
        sessionId: await newSession(OTHER),
        requestedSessionId: null,
        requestedSessionIgnored: false,
      },
      source: { text: "someone else's raw" },
      guidelines: [],
      runFacts: {
        engine: "structure",
        model: "m",
        provider: "p",
        promptVersion: "v",
      },
    });
    const theirs = foreign.intake.sourceDocumentIds[0]!;

    const mine = await structureInto(await newSession());
    const deleted = mine.intake.sourceDocumentIds[0]!;
    await q(`update documents set deleted_at = now() where id = $1`, [deleted]);

    for (const id of [theirs, deleted]) {
      const out = await structureInto(await newSession(), {
        reuseSourceDocumentId: id,
      });
      expect(out.intake.sourceDocumentIds).toEqual([]);
      expect(out.intake.errors?.join(" ")).toContain(
        `Intake source ${id} not found`
      );
    }
    expect(await intakeRows()).toHaveLength(0);
    expect(await intakeRows(OTHER)).toHaveLength(1);
  });

  it("import: one raw row per item; a foreign item id is counted as failed, never copied", async () => {
    const first = await importInto(await newSession());
    const original = first.sourceDocumentIds[0]!;

    const child = await newSession();
    const replay = await importInto(child, [
      { ...ITEM, sourceDocumentId: original },
    ]);
    expect(replay.sourceDocumentIds).toEqual([original]);
    expect((await manifestOf(child))!.sourceDocumentIds).toEqual([original]);
    expect((await intakeRows()).map((r) => r.id)).toEqual([original]);

    const foreignId = "00000000-0000-4000-8000-000000000000";
    const refused = await importInto(await newSession(), [
      { ...ITEM, sourceDocumentId: foreignId },
    ]);
    expect(refused.sourcesFailed).toBe(1);
    expect(refused.errors?.join(" ")).toContain(
      `Intake source ${foreignId} not found`
    );
    expect(await intakeRows()).toHaveLength(1);
  });
});
