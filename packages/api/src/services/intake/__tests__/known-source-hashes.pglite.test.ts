/**
 * The "already imported" ledger, on a real Postgres (PGlite).
 *
 * recordStructureIntake (real) → stageIntakeSource (real, via the real
 * DocumentRepository / stageSourceBlob) writes `intakeSource.fileSha256`;
 * findKnownSourceHashes / countRunFileSources (real SQL) read it back. The
 * manifest's per-source extraction fact is read off the real session row.
 *
 * Stubbed, as in `intake-run.pglite.test.ts`: object storage, the event
 * fan-out, and `openRunSession` (lives in @synap/database's own connection).
 *
 * NOT covered here: the `capture.structure` short-circuit itself (needs the IS,
 * profiles and search) — its shape is pinned by
 * `structure-intake-wiring.tripwire.test.ts`.
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
      checksum: "x",
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
    openRunSession: async (input: {
      userId: string;
      goal: string;
      workspaceId?: string | null;
      source: string;
      extraMetadata?: Record<string, unknown>;
      origin?: string;
    }) => {
      const metadata = { source: input.source, ...(input.extraMetadata ?? {}) };
      const { rows } = await client.query<{ id: string }>(
        `insert into focus_sessions (user_id, goal, status, workspace_id, origin, metadata)
         values ($1, $2, 'active', $3, $4, $5::jsonb) returning id`,
        [
          input.userId,
          input.goal,
          input.workspaceId ?? null,
          input.origin ?? "agent",
          JSON.stringify(metadata),
        ]
      );
      return { sessionId: rows[0]!.id, reused: false };
    },
  };
});

import { db } from "@synap/database";
import {
  defaultKeepOriginal,
  recordStructureIntake,
} from "../record-structure-intake.js";
import {
  readSessionRunManifest,
  runFactsFromStructureMeta,
} from "../record-session-run-manifest.js";
import {
  PHOTO_RUN_MAX_ITEMS,
  countRunFileSources,
  fileSha256Of,
  findKnownSourceHashes,
  findRunStagedSource,
  runFullMessage,
} from "../known-source-hashes.js";

const ME = "user-me";
const OTHER = "user-other";

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
  create table proposals (
    id uuid primary key default gen_random_uuid(), session_id uuid,
    status text not null default 'pending'
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

const photo = (label: string) => Buffer.from(`jpeg-bytes:${label}`);

function capturePhoto(
  bytes: Buffer,
  over: Partial<Parameters<typeof recordStructureIntake>[0]> = {}
) {
  return recordStructureIntake({
    database: db,
    userId: ME,
    workspaceId: null,
    source: {
      file: {
        content: bytes.toString("base64"),
        mimeType: "image/jpeg",
        filename: "IMG_1.jpg",
      },
    },
    extractedText: "## OCR\nReceipt total 12.40",
    extraction: { extractor: "vision", model: "gemini-x", provider: "prov-v" },
    guidelines: [],
    runFacts: runFactsFromStructureMeta({
      engine: "structure",
      model: "deepseek-chat",
      provider: "prov-s",
      promptVersion: "structure:1",
    }),
    ...over,
  });
}

async function sourceDoc(id: string) {
  const { rows } = await q<{
    metadata: Record<string, any>;
    mime_type: string;
  }>(`select metadata, mime_type from documents where id = $1`, [id]);
  return rows[0]!;
}

beforeAll(async () => {
  await h.client!.exec(DDL);
});
beforeEach(async () => {
  await h.client!.exec(
    `delete from document_versions; delete from documents; delete from proposals; delete from focus_sessions;`
  );
});

describe("the staging door writes the ledger key", () => {
  it("a photo's source records the plain sha256 of its bytes, the model that SAW it, and that the original was kept", async () => {
    const bytes = photo("a");
    const echo = await capturePhoto(bytes);
    const doc = await sourceDoc(echo.intake.sourceDocumentIds[0]!);

    expect(doc.metadata.intakeSource.fileSha256).toBe(fileSha256Of(bytes));
    expect(doc.mime_type).toBe("image/jpeg"); // bytes kept, not the markdown

    const { rows } = await q<{ metadata: Record<string, unknown> }>(
      `select metadata from focus_sessions where id = $1`,
      [echo.sessionId]
    );
    expect(readSessionRunManifest(rows[0]!.metadata)).toMatchObject({
      model: "deepseek-chat",
      extractions: [
        {
          sourceDocumentId: echo.intake.sourceDocumentIds[0],
          extractor: "vision",
          model: "gemini-x",
          provider: "prov-v",
          originalKept: true,
        },
      ],
    });
  });

  it("'extract text only' keeps the text, still records the hash, and says the original was not kept", async () => {
    const bytes = photo("text-only");
    const echo = await capturePhoto(bytes, { keepRaw: false });
    const doc = await sourceDoc(echo.intake.sourceDocumentIds[0]!);
    expect(doc.mime_type).toBe("text/markdown");
    expect(doc.metadata.intakeSource.fileSha256).toBe(fileSha256Of(bytes));
    const { rows } = await q<{ metadata: Record<string, unknown> }>(
      `select metadata from focus_sessions where id = $1`,
      [echo.sessionId]
    );
    expect(
      readSessionRunManifest(rows[0]!.metadata)?.extractions?.[0]
    ).toMatchObject({ originalKept: false });
  });

  it("a degraded photo names no model — nothing's answer was used", async () => {
    const echo = await capturePhoto(photo("deg"), {
      extractedText: undefined,
      degraded: { reason: "llm_budget_exceeded" },
    });
    const { rows } = await q<{ metadata: Record<string, unknown> }>(
      `select metadata from focus_sessions where id = $1`,
      [echo.sessionId]
    );
    expect(
      readSessionRunManifest(rows[0]!.metadata)?.extractions?.[0]
    ).toMatchObject({ model: null, provider: null, originalKept: true });
  });

  it("photos keep originals by default; other files keep today's text-only rule", () => {
    expect(defaultKeepOriginal("image/heic")).toBe(true);
    expect(defaultKeepOriginal("application/pdf")).toBe(false);
  });
});

describe("findKnownSourceHashes — owner-floored", () => {
  it("returns the caller's own analyzed hash with its run, and nothing for unknown bytes", async () => {
    const bytes = photo("known");
    const echo = await capturePhoto(bytes);
    const known = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [fileSha256Of(bytes), fileSha256Of(photo("never"))],
    });
    expect(known).toEqual([
      {
        hash: fileSha256Of(bytes),
        sessionId: echo.sessionId,
        documentId: echo.intake.sourceDocumentIds[0],
        status: "analyzed",
        // Structured but nothing filed yet: no proposal holds the run.
        inEffect: false,
        workspaceId: null,
      },
    ]);
  });

  it("another user's import of the SAME bytes is never revealed", async () => {
    const bytes = photo("shared");
    await capturePhoto(bytes, { userId: OTHER });
    const known = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [fileSha256Of(bytes)],
    });
    expect(known).toEqual([]);
  });

  it("a degraded source reads as kept_unanalyzed, and an analyzed copy wins over it", async () => {
    const bytes = photo("retry");
    await capturePhoto(bytes, {
      extractedText: undefined,
      degraded: { reason: "vision_provider_not_configured" },
      correlationKey: null,
    });
    const first = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [fileSha256Of(bytes)],
    });
    expect(first[0]?.status).toBe("kept_unanalyzed");

    await capturePhoto(bytes, { correlationKey: null });
    const second = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [fileSha256Of(bytes).toUpperCase()],
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.status).toBe("analyzed");
  });
});

describe("a caption that structured, with a photo that was NOT read", () => {
  it("files the photo's source as kept_unanalyzed, keeps its bytes, and names no model", async () => {
    const bytes = photo("caption-only");
    const echo = await capturePhoto(bytes, {
      // The IS returned `extraction.degraded` with an empty text; the outcome
      // itself (the caption's plan) is NOT degraded.
      extractedText: "",
      fileNotRead: { reason: "vision_provider_not_configured" },
      source: {
        text: "Sunset at the beach",
        file: {
          content: bytes.toString("base64"),
          mimeType: "image/jpeg",
          filename: "IMG_2.jpg",
        },
      },
      correlationKey: null,
    });
    const known = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [fileSha256Of(bytes)],
    });
    expect(known[0]?.status).toBe("kept_unanalyzed");
    // Only the FILE is marked — the caption's text source structured.
    const docs = await Promise.all(
      echo.intake.sourceDocumentIds.map(sourceDoc)
    );
    expect(docs.map((d) => Boolean(d.metadata.intakeSource?.degraded))).toEqual(
      [false, true]
    );
    expect(echo.intake.degradedSourceKept).toBeUndefined();
    const { rows } = await q<{ metadata: Record<string, any> }>(
      `select metadata from focus_sessions where id = $1`,
      [echo.sessionId]
    );
    expect(rows[0]!.metadata.run.extractions[0]).toMatchObject({
      model: null,
      provider: null,
      originalKept: true,
    });
  });
});

describe("scope — the capture short-circuit's workspace and 'run still in effect'", () => {
  const WS_A = "11111111-1111-4111-8111-111111111111";
  const WS_B = "22222222-2222-4222-8222-222222222222";
  const fileProposal = (sessionId: string, status: string) =>
    q(
      `insert into proposals (session_id, status) values ($1, $2) returning id`,
      [sessionId, status]
    );

  it("a run holding an applied proposal is in effect; a reverted one is not", async () => {
    const bytes = photo("undo-me");
    const echo = await capturePhoto(bytes, { workspaceId: WS_A });
    const { rows } = await fileProposal(echo.sessionId!, "auto_approved");

    const live = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [fileSha256Of(bytes)],
      workspaceId: WS_A,
    });
    expect(live[0]).toMatchObject({
      status: "analyzed",
      inEffect: true,
      workspaceId: WS_A,
    });

    await q(`update proposals set status = 'reverted' where id = $1`, [
      (rows[0] as { id: string }).id,
    ]);
    const undone = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [fileSha256Of(bytes)],
      workspaceId: WS_A,
    });
    expect(undone[0]).toMatchObject({ status: "analyzed", inEffect: false });
  });

  it("a photo imported into workspace A is unknown to a capture into B (and to pod-wide)", async () => {
    const bytes = photo("ws-a-only");
    const echo = await capturePhoto(bytes, { workspaceId: WS_A });
    await fileProposal(echo.sessionId!, "approved");

    for (const workspaceId of [WS_B, null]) {
      expect(
        await findKnownSourceHashes({
          database: db,
          userId: ME,
          hashes: [fileSha256Of(bytes)],
          workspaceId,
        })
      ).toEqual([]);
    }
    // Unscoped (the phone's question): known, naming its workspace.
    const unscoped = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [fileSha256Of(bytes)],
    });
    expect(unscoped[0]).toMatchObject({ inEffect: true, workspaceId: WS_A });
  });

  it("an in-effect copy outranks a newer undone copy of the same bytes", async () => {
    const bytes = photo("two-runs");
    const first = await capturePhoto(bytes, { correlationKey: null });
    await fileProposal(first.sessionId!, "approved");
    const second = await capturePhoto(bytes, { correlationKey: null });
    await fileProposal(second.sessionId!, "rejected");

    const [best] = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [fileSha256Of(bytes)],
      workspaceId: null,
    });
    expect(best).toMatchObject({ sessionId: first.sessionId, inEffect: true });
  });
});

describe("sourceSha256 — the client's hash of the ORIGINAL asset", () => {
  // Relay re-encodes (HEIC→JPEG, 2048px) before sending, and a re-encode is not
  // byte-stable: only the original's hash recognises the photo on a later scan.
  const original = "a".repeat(64);

  it("is staged, and the ledger finds the source by it — echoing the asked hash", async () => {
    const sent = photo("re-encoded");
    const echo = await capturePhoto(sent, {
      source: {
        file: {
          content: sent.toString("base64"),
          mimeType: "image/jpeg",
          filename: "IMG_2.jpg",
        },
        sourceSha256: original.toUpperCase(),
      },
    });
    const doc = await sourceDoc(echo.intake.sourceDocumentIds[0]!);
    expect(doc.metadata.intakeSource).toMatchObject({
      fileSha256: fileSha256Of(sent),
      sourceSha256: original,
    });

    // The camera-roll scan's real question: the ORIGINAL hash alone. (Asking
    // with both hashes at once would match the row through fileSha256 and hide
    // a lookup that ignores sourceSha256 — the negative control proved it.)
    const byOriginalOnly = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [original],
    });
    expect(byOriginalOnly).toEqual([
      expect.objectContaining({
        hash: original,
        documentId: echo.intake.sourceDocumentIds[0],
        status: "analyzed",
      }),
    ]);

    const known = await findKnownSourceHashes({
      database: db,
      userId: ME,
      hashes: [original, fileSha256Of(sent)],
    });
    expect(known.map((k) => [k.hash, k.documentId])).toEqual([
      [original, echo.intake.sourceDocumentIds[0]],
      [fileSha256Of(sent), echo.intake.sourceDocumentIds[0]],
    ]);

    expect(
      await findKnownSourceHashes({
        database: db,
        userId: OTHER,
        hashes: [original],
      })
    ).toEqual([]);
  });

  it("a retry re-encoded to DIFFERENT bytes still counts as already in the run", async () => {
    const first = photo("enc-1");
    const echo = await capturePhoto(first, {
      source: {
        file: { content: first.toString("base64"), mimeType: "image/jpeg" },
        sourceSha256: original,
      },
    });
    const counted = await countRunFileSources({
      database: db,
      userId: ME,
      sessionId: echo.sessionId!,
      fileSha256: fileSha256Of(photo("enc-2")),
      sourceSha256: original,
    });
    expect(counted).toEqual({ count: 1, containsHash: true });
  });
});

describe("findRunStagedSource — what capture.execute links instead of re-uploading", () => {
  it("finds the run's kept photo by its structure-echoed document id, by fileSha256, and by sourceSha256", async () => {
    const bytes = photo("run-src");
    const original = "b".repeat(64);
    const echo = await capturePhoto(bytes, {
      source: {
        file: {
          content: bytes.toString("base64"),
          mimeType: "image/jpeg",
          filename: "IMG_9.jpg",
        },
        sourceSha256: original,
      },
    });
    const docId = echo.intake.sourceDocumentIds[0]!;
    const base = { database: db, userId: ME, sessionId: echo.sessionId! };

    for (const by of [
      { sourceDocumentId: docId },
      { fileSha256: fileSha256Of(bytes) },
      { sourceSha256: original },
    ]) {
      expect(await findRunStagedSource({ ...base, ...by })).toMatchObject({
        documentId: docId,
        mimeType: "image/jpeg",
        filename: "IMG_9.jpg",
        storageKey: expect.any(String),
      });
    }
  });

  it("never offers a text-only rendition, another run's source, or another user's", async () => {
    const textOnly = await capturePhoto(photo("text"), { keepRaw: false });
    expect(
      await findRunStagedSource({
        database: db,
        userId: ME,
        sessionId: textOnly.sessionId!,
        sourceDocumentId: textOnly.intake.sourceDocumentIds[0]!,
      })
    ).toBeNull();

    const kept = await capturePhoto(photo("kept"));
    const other = await capturePhoto(photo("other-run"), {
      correlationKey: null,
    });
    const keptDoc = kept.intake.sourceDocumentIds[0]!;
    expect(
      await findRunStagedSource({
        database: db,
        userId: ME,
        sessionId: other.sessionId!,
        sourceDocumentId: keptDoc,
      })
    ).toBeNull();
    expect(
      await findRunStagedSource({
        database: db,
        userId: OTHER,
        sessionId: kept.sessionId!,
        sourceDocumentId: keptDoc,
      })
    ).toBeNull();
  });
});

describe("the per-run cap", () => {
  it("counts the run's FILE sources and recognises a retried item", async () => {
    const a = photo("r1");
    const echo = await capturePhoto(a);
    await capturePhoto(photo("r2"), { bodyHandle: echo.sessionId });
    await recordStructureIntake({
      database: db,
      userId: ME,
      workspaceId: null,
      bodyHandle: echo.sessionId,
      source: { text: "a typed note in the same run" },
      guidelines: [],
      runFacts: runFactsFromStructureMeta(undefined),
    });
    const counted = await countRunFileSources({
      database: db,
      userId: ME,
      sessionId: echo.sessionId!,
      fileSha256: fileSha256Of(a),
    });
    expect(counted).toEqual({ count: 2, containsHash: true });
    const otherUser = await countRunFileSources({
      database: db,
      userId: OTHER,
      sessionId: echo.sessionId!,
      fileSha256: fileSha256Of(a),
    });
    expect(otherUser).toEqual({ count: 0, containsHash: false });
  });

  it("a full run is always rerunnable whole: the cap never exceeds the rerun cap", async () => {
    const { RERUN_MAX_SOURCES } =
      await import("../../focus-sessions/rerun-session.js");
    expect(PHOTO_RUN_MAX_ITEMS).toBeLessThanOrEqual(RERUN_MAX_SOURCES);
    expect(runFullMessage(PHOTO_RUN_MAX_ITEMS)).toMatch(/^run_full: /);
  });
});
