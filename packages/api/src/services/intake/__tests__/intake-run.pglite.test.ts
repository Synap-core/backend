/**
 * A RUN IS A SESSION — the intake doors driven on a real Postgres (PGlite).
 *
 * recordStructureIntake (real) → ensureIntakeSession (real, incl. the real
 * `resolveVerifiedSessionId` ownership query) → stageIntakeSource (real, through
 * the real `DocumentRepository` / `stageSourceBlob`) → recordSessionRunManifest
 * (real SQL, real row lock). Every assertion reads the rows back from the
 * database; nothing downstream is hand-built.
 *
 * What is stubbed, and why:
 *  - `@synap/storage` — object storage; an in-memory upload that reports the
 *    same `{url, path, size}` shape.
 *  - `eventRepository.append` — the post-commit event fan-out (own suites).
 *  - `openRunSession` — it lives in `@synap/database` and queries through that
 *    package's OWN connection, which a test cannot redirect. The stub inserts the
 *    row with the metadata composition the real door uses
 *    (`{ source, ...extraMetadata }`, origin `agent`) — so the KIND assertion
 *    proves `session-kind.ts` classifies that composition as a run; it does not
 *    prove openRunSession's own insert.
 *
 * NOT covered (NEEDS-DOGFOOD): the procedures themselves (`capture.structure`
 * calls `recordStructureIntake` on each outcome; Hub/MCP forward the echo) —
 * those need the IS, profiles, search and a live pod.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  objects: new Map<string, number>(),
}));

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (userId: string, kind: string, id: string, ext: string) =>
      `${userId}/${kind}/${id}.${ext}`,
    upload: async (key: string, body: Buffer | string) => {
      const size = Buffer.byteLength(body);
      h.objects.set(key, size);
      return { url: `mem://${key}`, path: key, size };
    },
    delete: async (key: string) => void h.objects.delete(key),
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
      // Same origin rule as the real door: explicit `origin` wins, else "agent".
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

import { db, composeStructureContext } from "@synap/database";
import {
  capturePlanKey,
  recordStructureIntake,
  structureSourceKind,
} from "../record-structure-intake.js";
import { ensureIntakeSession } from "../ensure-intake-session.js";
import {
  recordSessionRunManifest,
  runFactsFromStructureMeta,
  readSessionRunManifest,
} from "../record-session-run-manifest.js";
import { recordImportIntake } from "../record-import-intake.js";
import { projectSessionKind } from "../../focus-sessions/session-kind.js";
import { shouldPersistCapturePlan } from "../../capture-agent/capture-structure-to-graph.js";

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

const IS_META = {
  engine: "structure" as const,
  model: "model-x",
  provider: "prov-y",
  promptVersion: "structure:abc123def456",
};

function structureIntake(
  over: Partial<Parameters<typeof recordStructureIntake>[0]> = {}
) {
  return recordStructureIntake({
    database: db,
    userId: USER,
    workspaceId: null,
    source: { text: "Met Ada Lovelace at the Analytical Engine demo" },
    guidelines: [{ id: "g-screens", version: 3 }],
    guidelineStatus: "ok",
    runFacts: runFactsFromStructureMeta(IS_META),
    ...over,
  });
}

async function sessionRow(id: string) {
  const { rows } = await q<{
    user_id: string;
    origin: string | null;
    playbook_id: string | null;
    status: string;
    metadata: Record<string, unknown>;
  }>(
    `select user_id, origin, playbook_id, status, metadata from focus_sessions where id = $1`,
    [id]
  );
  return rows[0];
}

beforeAll(async () => {
  await h.client!.exec(DDL);
});
beforeEach(async () => {
  await h.client!.exec(
    `delete from document_versions; delete from documents; delete from focus_sessions;`
  );
});

describe("a text capture with no session", () => {
  it("mints a RUN session, stores the text as a source document, records the manifest, and echoes the id", async () => {
    const echo = await structureIntake();

    expect(echo.intake).toMatchObject({
      status: "recorded",
      sessionSource: "minted",
      requestedSessionIgnored: false,
    });
    expect(echo.sessionId).toEqual(expect.any(String));
    expect(echo.intake.sourceDocumentIds).toHaveLength(1);

    const session = await sessionRow(echo.sessionId!);
    expect(session!.user_id).toBe(USER);
    expect(
      projectSessionKind({
        origin: session!.origin,
        playbookId: session!.playbook_id,
        metadata: session!.metadata,
        status: session!.status,
      })
    ).toBe("run");

    const manifest = readSessionRunManifest(session!.metadata);
    expect(manifest).toMatchObject({
      sourceDocumentIds: echo.intake.sourceDocumentIds,
      guidelines: [{ id: "g-screens", version: 3 }],
      guidelineStatus: "ok",
      engine: "structure",
      model: "model-x",
      provider: "prov-y",
      promptVersion: "structure:abc123def456",
    });

    const { rows: docs } = await q<{
      metadata: Record<string, any>;
      content: string;
    }>(
      `select d.metadata, v.content from documents d join document_versions v on v.document_id = d.id where d.id = $1`,
      [echo.intake.sourceDocumentIds[0]]
    );
    expect(docs[0]!.content).toBe(
      "Met Ada Lovelace at the Analytical Engine demo"
    );
    expect(docs[0]!.metadata.intakeSource).toMatchObject({
      kind: "text",
      sessionId: echo.sessionId,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("a retry of the same capture lands in the SAME room and does not store the input twice", async () => {
    const first = await structureIntake();
    const second = await structureIntake();
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.intake.sourceDocumentIds).toEqual(
      first.intake.sourceDocumentIds
    );
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from documents`
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("execute's later patch (the idempotency namespace) merges without losing the sources", async () => {
    const echo = await structureIntake();
    const res = await recordSessionRunManifest({
      database: db,
      sessionId: echo.sessionId!,
      userId: USER,
      patch: { idempotencyNamespace: `${USER}:cap-text:2026-09-13:abc` },
    });
    expect(res.ok).toBe(true);
    const manifest = readSessionRunManifest(
      (await sessionRow(echo.sessionId!))!.metadata
    );
    expect(manifest).toMatchObject({
      idempotencyNamespace: `${USER}:cap-text:2026-09-13:abc`,
      sourceDocumentIds: echo.intake.sourceDocumentIds,
      model: "model-x",
    });
  });

  it("an older IS (no meta) is recorded as unknown, never guessed", () => {
    expect(runFactsFromStructureMeta(undefined)).toEqual({
      engine: "unknown",
      model: "unknown",
      provider: "unknown",
      promptVersion: "unknown",
    });
  });
});

describe("room reuse is narrow (review must-fix 2, 4, F)", () => {
  const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("a CLOSED room is never refilled by a retry — a new one is minted", async () => {
    const first = await structureIntake();
    await q(`update focus_sessions set status = 'closed' where id = $1`, [
      first.sessionId,
    ]);
    const retry = await structureIntake();
    expect(retry.sessionId).not.toBe(first.sessionId);
    expect(retry.intake.sessionSource).toBe("minted");
  });

  it("a retry in ANOTHER workspace never reuses the room", async () => {
    const inA = await structureIntake({ workspaceId: WS_A });
    const inB = await structureIntake({ workspaceId: WS_B });
    expect(inB.sessionId).not.toBe(inA.sessionId);
  });

  it("a person's capture room is origin human; an agent's is origin agent", async () => {
    const human = await structureIntake();
    const agent = await structureIntake({
      agentUserId: "agent-9",
      source: { text: "a different capture" },
    });
    expect((await sessionRow(human.sessionId!))!.origin).toBe("human");
    expect((await sessionRow(agent.sessionId!))!.origin).toBe("agent");
  });

  it("execute lands in structure's room by the PLAN, even when the client did not forward the id", async () => {
    const plan = {
      proposals: [
        {
          tempId: "t1",
          profileSlug: "person",
          title: "Ada Lovelace",
          properties: { role: "cto" },
        },
        { tempId: "t2", profileSlug: "company", title: "Analytical Engines" },
      ],
      relations: [
        { sourceTempId: "t1", targetTempId: "t2", relationType: "works_at" },
      ],
    };
    const structured = await structureIntake({
      planKey: capturePlanKey(plan.proposals, plan.relations),
    });
    // What the client sends to execute: the same plan, entities re-ordered.
    const executeEntities = [plan.proposals[1], plan.proposals[0]];
    const executed = await ensureIntakeSession({
      userId: USER,
      workspaceId: null,
      door: "capture",
      goal: "Capture · execute",
      planKey: capturePlanKey(executeEntities, plan.relations),
    });
    expect(executed).toMatchObject({ status: "minted", reused: true });
    expect(executed.sessionId).toBe(structured.sessionId);

    // An EDITED plan is a different plan — no reuse.
    const edited = await ensureIntakeSession({
      userId: USER,
      workspaceId: null,
      door: "capture",
      goal: "Capture · execute",
      planKey: capturePlanKey(
        [{ ...plan.proposals[0], title: "Ada King" }, plan.proposals[1]],
        plan.relations
      ),
    });
    expect(edited.sessionId).not.toBe(structured.sessionId);
  });
});

describe("the session a caller sends", () => {
  it("an UNOWNED session id is not used — the response names the real session, the foreign one is untouched", async () => {
    const { rows } = await q<{ id: string }>(
      `insert into focus_sessions (user_id, goal, origin) values ('someone-else', 'theirs', 'human') returning id`
    );
    const foreign = rows[0]!.id;

    const echo = await structureIntake({ bodyHandle: foreign });

    expect(echo.sessionId).not.toBe(foreign);
    expect(echo.intake).toMatchObject({
      sessionSource: "minted",
      requestedSessionIgnored: true,
    });
    expect((await sessionRow(foreign))!.metadata).toEqual({});
    const { rows: leaked } = await q<{ n: number }>(
      `select count(*)::int as n from documents where metadata #>> '{intakeSource,sessionId}' = $1`,
      [foreign]
    );
    expect(leaked[0]!.n).toBe(0);
  });

  it("an OWNED session is used as-is, keeps its kind, and receives the manifest", async () => {
    const { rows } = await q<{ id: string }>(
      `insert into focus_sessions (user_id, goal, origin) values ($1, 'my work', 'human') returning id`,
      [USER]
    );
    const mine = rows[0]!.id;

    const echo = await structureIntake({ bodyHandle: mine });

    expect(echo.sessionId).toBe(mine);
    expect(echo.intake).toMatchObject({
      sessionSource: "provided",
      requestedSessionIgnored: false,
    });
    const session = await sessionRow(mine);
    expect(
      readSessionRunManifest(session!.metadata)?.sourceDocumentIds
    ).toHaveLength(1);
    expect(
      projectSessionKind({ ...session!, playbookId: session!.playbook_id })
    ).toBe("work");
  });
});

describe("a degraded capture", () => {
  it("keeps the source as a document with a degraded marker and files NO proposal", async () => {
    const echo = await structureIntake({
      degraded: { reason: "is_invalid_response" },
      runFacts: runFactsFromStructureMeta(undefined, { podDegraded: true }),
    });

    expect(echo.intake).toMatchObject({
      status: "recorded",
      degradedSourceKept: true,
    });
    const { rows } = await q<{ metadata: Record<string, any> }>(
      `select metadata from documents where id = $1`,
      [echo.intake.sourceDocumentIds[0]]
    );
    expect(rows[0]!.metadata.intakeSource.degraded).toMatchObject({
      reason: "is_invalid_response",
    });
    expect(
      readSessionRunManifest((await sessionRow(echo.sessionId!))!.metadata)
    ).toMatchObject({ engine: "degraded", model: null });
    // The proposal half of D6 stays the confirm-mode guard's refusal.
    expect(
      shouldPersistCapturePlan({
        degraded: true,
        proposals: [{ tempId: "t1" }],
      })
    ).toBe(false);
  });

  it("a later successful structure of the same input clears the marker instead of storing a copy", async () => {
    const degraded = await structureIntake({
      degraded: { reason: "is_invalid_response" },
    });
    const ok = await structureIntake();
    expect(ok.intake.sourceDocumentIds).toEqual(
      degraded.intake.sourceDocumentIds
    );
    const { rows } = await q<{ metadata: Record<string, any> }>(
      `select metadata from documents where id = $1`,
      [ok.intake.sourceDocumentIds[0]]
    );
    expect(rows[0]!.metadata.intakeSource.degraded).toBeUndefined();
    expect(rows[0]!.metadata.intakeSource.restructuredAt).toEqual(
      expect.any(String)
    );
  });

  it("a degraded FILE keeps its original bytes, so it can be re-structured", async () => {
    const png = Buffer.from("fake-png-bytes");
    const echo = await structureIntake({
      source: {
        file: {
          content: png.toString("base64"),
          mimeType: "image/png",
          filename: "shot.png",
        },
      },
      degraded: { reason: "vision_provider_not_configured" },
    });
    expect(echo.intake.degradedSourceKept).toBe(true);
    const { rows } = await q<{
      mime_type: string;
      size: number;
      metadata: Record<string, any>;
    }>(`select mime_type, size, metadata from documents where id = $1`, [
      echo.intake.sourceDocumentIds[0],
    ]);
    expect(rows[0]).toMatchObject({ mime_type: "image/png", size: png.length });
    expect(rows[0]!.metadata.intakeSource).toMatchObject({
      kind: "file",
      filename: "shot.png",
    });
  });
});

describe("guidelines reach an image capture", () => {
  it("an image file derives the `image` source kind, and a guideline scoped to it lands in the instructions", () => {
    expect(structureSourceKind({ file: { mimeType: "image/png" } })).toBe(
      "image"
    );
    expect(structureSourceKind({ file: { mimeType: "audio/wav" } })).toBe(
      "audio"
    );
    expect(structureSourceKind({ url: "https://x.test" })).toBe("url");
    expect(structureSourceKind({})).toBe("text");
    const ctx = composeStructureContext({
      guidelines: [
        {
          id: "g-img",
          version: 2,
          scopeKind: "sourceKind",
          scopeRef: "image",
          specificity: 5,
          text: "Screenshots of bookmarks are items to review weekly.",
        },
      ] as Parameters<typeof composeStructureContext>[0]["guidelines"],
      instructions: ["caller instruction"],
    });
    expect(ctx.instructions).toContain(
      "Screenshots of bookmarks are items to review weekly."
    );
    expect(ctx.guidelines).toEqual([{ id: "g-img", version: 2 }]);
  });
});

describe("an import analyze run", () => {
  it("stores every item as a source document and records them on the session manifest", async () => {
    const { rows } = await q<{ id: string }>(
      `insert into focus_sessions (user_id, goal, origin, metadata) values ($1, 'Import', 'agent', '{"intake":{"door":"import"}}'::jsonb) returning id`,
      [USER]
    );
    const result = await recordImportIntake({
      database: db,
      userId: USER,
      workspaceId: null,
      sessionId: rows[0]!.id,
      source: "markdown",
      items: [
        { path: "notes/a.md", content: "# A\nalpha" },
        { path: "notes/b.md", content: "# B\nbeta" },
        { path: "notes/empty.md", content: "   " },
      ],
      run: {
        guidelines: [],
        guidelineStatus: "ok",
        engine: "deterministic",
        model: null,
        promptVersion: "none",
      },
    });
    expect(result).toMatchObject({
      sourcesFailed: 0,
      sourcesEmpty: 1,
      manifest: "recorded",
    });
    expect(result.sourceDocumentIds).toHaveLength(2);
    const manifest = readSessionRunManifest(
      (await sessionRow(rows[0]!.id))!.metadata
    );
    expect(manifest?.sourceDocumentIds).toEqual(result.sourceDocumentIds);
    const { rows: docs } = await q<{ path: string }>(
      `select metadata #>> '{intakeSource,path}' as path from documents order by path`
    );
    expect(docs.map((d) => d.path)).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("a session the caller does not own gets no manifest", async () => {
    const { rows } = await q<{ id: string }>(
      `insert into focus_sessions (user_id, goal) values ('someone-else', 'x') returning id`
    );
    const res = await recordSessionRunManifest({
      database: db,
      sessionId: rows[0]!.id,
      userId: USER,
      patch: { sourceDocumentIds: ["d1"] },
    });
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect((await sessionRow(rows[0]!.id))!.metadata).toEqual({});
  });
});
