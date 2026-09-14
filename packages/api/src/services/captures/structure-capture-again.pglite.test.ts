/**
 * `captures.structureAgain` — redo one capture from its raw, including a
 * capture with NO run — on PGlite.
 *
 * Real: the procedure for everything decided before a rerun (auth, rate limit,
 * owner floor → NOT_FOUND, `unsupported_kind`); the service for the rest, with
 * the real `scopedDb` documents rule, `ensureIntakeSession`,
 * `recordSessionRunManifest`, `DocumentRepository`, and the REAL `rerunSession`
 * (plan, refusals, child mint, body loading).
 *
 * Stubbed, and why (the same boundaries `rerun-session.pglite.test.ts` uses):
 *  - `openRunSession` — `@synap/database`'s own connection; the stub inserts the
 *    row it was handed and records the call;
 *  - the REPLAYERS — the IS boundary; the stub records what it would structure;
 *  - the PARENT LOCK — PGlite is one connection, a real `FOR UPDATE`
 *    transaction deadlocks the mint inside it;
 *  - `@synap/storage` — in-memory objects; the event fan-out.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  opened: [] as Array<Record<string, unknown>>,
  objects: new Map<string, Buffer>(),
}));

vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    buildPath: () => "unused",
    upload: async () => ({ url: "mem://x", path: "x", size: 0 }),
    downloadBuffer: async (key: string) => {
      const bytes = h.objects.get(key);
      if (!bytes) throw new Error(`no stored object ${key}`);
      return bytes;
    },
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
    db: drizzle(client, {
      schema: {
        documents: actual.documents as never,
        focusSessions: actual.focusSessions as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    openRunSession: async (input: {
      userId: string;
      goal: string;
      workspaceId?: string | null;
      source: string;
      extraMetadata?: Record<string, unknown>;
    }) => {
      h.opened.push(input as unknown as Record<string, unknown>);
      const { rows } = await client.query<{ id: string }>(
        `insert into focus_sessions (id, user_id, goal, status, workspace_id, metadata, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, 'active', $3, $4::jsonb, now(), now()) returning id`,
        [
          input.userId,
          input.goal,
          input.workspaceId ?? null,
          JSON.stringify({
            source: input.source,
            ...(input.extraMetadata ?? {}),
          }),
        ]
      );
      return { sessionId: rows[0]!.id, reused: false };
    },
  };
});

vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  chatTurns,
  documents,
  documentVersions,
  entities,
  entityFacets,
  focusSessions,
  links,
  messages,
  podMembers,
  profiles,
  projectMembers,
  proposals,
  relations,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import { capturesRouter } from "../../routers/captures.js";
import { structureCaptureAgain } from "./structure-capture-again.js";
import {
  rerunSession,
  type ParentLock,
  type RerunReplayers,
  type RerunSource,
} from "../focus-sessions/rerun-session.js";
import { readSessionRunManifest } from "../intake/record-session-run-manifest.js";

const A = "user-a";
const B = "user-b";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ctxOf = (userId: string, agentUserId?: string) =>
  ({
    authenticated: true,
    userId,
    ...(agentUserId ? { agentUserId } : {}),
  }) as never;

const replayed: RerunSource[] = [];
const replayers: RerunReplayers = {
  capture: async (source) => {
    replayed.push(source);
    return { outcome: "proposed", proposalId: randomUUID() };
  },
  import: async (items) => {
    replayed.push(...items);
    return { outcome: "proposed", proposalId: randomUUID() };
  },
};
const lock: ParentLock = (_id, fn) => fn();
const rerun: typeof rerunSession = (a) =>
  rerunSession({ ...a, replayers, withParentLock: lock });

const redo = (
  documentId: string,
  over: Partial<Parameters<typeof structureCaptureAgain>[0]> = {}
) =>
  structureCaptureAgain({
    documentId,
    userId: A,
    mode: "add",
    callerContext: ctxOf(A),
    rerun,
    ...over,
  });

async function capture(
  opts: {
    userId?: string;
    workspaceId?: string | null;
    sessionId?: string | null;
    kind?: string;
    text?: string;
    file?: { bytes: Buffer; mimeType: string };
  } = {}
): Promise<string> {
  const id = randomUUID();
  const storageKey = opts.file ? `obj/${id}` : null;
  if (opts.file) h.objects.set(storageKey!, opts.file.bytes);
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type, metadata, created_at, updated_at)
     values ($1, $2, $3, 'src', 'markdown', $4, $5, $6::jsonb, now(), now())`,
    [
      id,
      opts.userId ?? A,
      opts.workspaceId ?? null,
      storageKey,
      opts.file?.mimeType ?? "text/markdown",
      JSON.stringify({
        intakeSource: {
          version: 1,
          kind: opts.kind ?? (opts.file ? "file" : "text"),
          contentHash: randomUUID(),
          sessionId: opts.sessionId ?? null,
          door: "capture.execute",
          ...(opts.file
            ? { mimeType: opts.file.mimeType, retainedUntilStructured: true }
            : {}),
        },
      }),
    ]
  );
  if (!opts.file) {
    await q(
      `insert into document_versions (id, document_id, version, content) values ($1, $2, 1, $3)`,
      [randomUUID(), id, opts.text ?? "call dana about the lease"]
    );
  }
  return id;
}

async function runHolding(sourceIds: string[]): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, created_at, updated_at)
     values ($1, $2, 'Capture', 'completed', $3::jsonb, now(), now())`,
    [id, A, JSON.stringify({ run: { sourceDocumentIds: sourceIds } })]
  );
  return id;
}

const sourceMeta = async (documentId: string) =>
  (
    await q<{ metadata: { intakeSource: Record<string, unknown> } }>(
      `select metadata from documents where id = $1`,
      [documentId]
    )
  ).rows[0]!.metadata.intakeSource;

const manifestIds = async (sessionId: string) =>
  readSessionRunManifest(
    (
      await q<{ metadata: unknown }>(
        `select metadata from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!.metadata
  )?.sourceDocumentIds ?? [];

const sessionCount = async () =>
  Number(
    (await q<{ n: string }>(`select count(*)::text as n from focus_sessions`))
      .rows[0]!.n
  );

/** Adoption mints carry no parent; a rerun's child mint does. */
const adoptionMints = () => h.opened.filter((o) => !o.parentSessionId);

describe("captures.structureAgain", () => {
  beforeAll(async () => {
    for (const t of [
      documents,
      documentVersions,
      entities,
      entityFacets,
      relations,
      projectMembers,
      workspaces,
      workspaceMembers,
      podMembers,
      focusSessions,
      links,
      messages,
      profiles,
      proposals,
      chatTurns,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `create schema pgboss; create table pgboss.job (id uuid primary key default gen_random_uuid(), name text not null, state text not null, data jsonb not null);`
    );
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from documents; delete from document_versions; delete from focus_sessions; delete from proposals; delete from workspaces; delete from workspace_members;"
    );
    h.opened.length = 0;
    replayed.length = 0;
    h.objects.clear();
  });

  it("owner floor: B cannot redo A's capture, even in a shared workspace — NOT_FOUND, nothing minted", async () => {
    const ws = randomUUID();
    await q(
      `insert into workspaces (id, owner_id, name) values ($1, $2, 'Shared')`,
      [ws, A]
    );
    for (const u of [A, B]) {
      await q(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
        [randomUUID(), ws, u]
      );
    }
    const mine = await capture({ workspaceId: ws });
    await expect(
      capturesRouter.createCaller(ctxOf(B)).structureAgain({ documentId: mine })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.opened).toEqual([]);
  });

  it("a machine kind is refused before anything is written", async () => {
    const machine = await capture({ kind: "sync_record" });
    const out = await capturesRouter
      .createCaller(ctxOf(A))
      .structureAgain({ documentId: machine });
    expect(out).toMatchObject({ ok: false, reason: "unsupported_kind" });
    expect(await sessionCount()).toBe(0);
    expect((await sourceMeta(machine)).sessionId).toBeNull();
  });

  it("a capture with NO run is adopted into one, then rerun from its raw; a second press adopts nothing again", async () => {
    const doc = await capture();
    const out = await redo(doc);

    expect(adoptionMints()).toHaveLength(1);
    expect(adoptionMints()[0]!.extraMetadata).toMatchObject({
      intake: { correlationKey: `capture-run:${doc}` },
    });
    const runId = (await sourceMeta(doc)).sessionId as string;
    expect(runId).toEqual(expect.any(String));
    expect(await manifestIds(runId)).toEqual([doc]);
    expect(out).toMatchObject({
      ok: true,
      status: "rerun",
      parentSessionId: runId,
      runSessionId: runId,
    });
    expect(replayed.map((s) => s.sourceDocumentId)).toEqual([doc]);

    await redo(doc);
    expect(adoptionMints()).toHaveLength(1);
  });

  it("a capture already in a multi-source run: add reruns ONLY it; replace is refused (dry run too)", async () => {
    const doc = await capture();
    const sibling = await capture();
    const run = await runHolding([doc, sibling]);
    await q(
      `update documents set metadata = jsonb_set(metadata, '{intakeSource,sessionId}', to_jsonb($1::text)) where id = any($2::uuid[])`,
      [run, [doc, sibling]]
    );

    const added = await redo(doc);
    expect(added).toMatchObject({
      ok: true,
      status: "rerun",
      parentSessionId: run,
    });
    expect(added.ok && "plan" in added && added.plan!.sources.selected).toBe(1);
    expect(replayed.map((s) => s.sourceDocumentId)).toEqual([doc]);
    expect(adoptionMints()).toHaveLength(0);

    for (const dryRun of [true, false]) {
      expect(await redo(doc, { mode: "replace", dryRun })).toMatchObject({
        ok: false,
        reason: "replace_wider_than_capture",
        runSessionId: run,
      });
    }
  });

  it("replace is allowed when the run holds only this capture (dry run answers the real plan)", async () => {
    const doc = await capture();
    const run = await runHolding([doc]);
    await q(
      `update documents set metadata = jsonb_set(metadata, '{intakeSource,sessionId}', to_jsonb($1::text)) where id = $2`,
      [run, doc]
    );
    expect(await redo(doc, { mode: "replace", dryRun: true })).toMatchObject({
      ok: true,
      status: "dry_run",
      parentSessionId: run,
      mode: "replace",
    });
  });

  it("a run whose manifest lost the capture is repaired, then delegated", async () => {
    const doc = await capture();
    const run = await runHolding([]);
    await q(
      `update documents set metadata = jsonb_set(metadata, '{intakeSource,sessionId}', to_jsonb($1::text)) where id = $2`,
      [run, doc]
    );
    const out = await redo(doc);
    expect(await manifestIds(run)).toEqual([doc]);
    expect(adoptionMints()).toHaveLength(0);
    expect(out).toMatchObject({
      ok: true,
      status: "rerun",
      parentSessionId: run,
    });
  });

  it("dry run on a capture with no run writes NOTHING and answers the plan", async () => {
    const doc = await capture();
    const out = await redo(doc, { dryRun: true });
    expect(out).toMatchObject({
      ok: true,
      status: "dry_run",
      parentSessionId: null,
      runSessionId: null,
      availability: { available: true },
    });
    expect(out.ok && "plan" in out && out.plan!.sources).toMatchObject({
      selected: 1,
      capture: 1,
    });
    expect(await sessionCount()).toBe(0);
    expect((await sourceMeta(doc)).sessionId).toBeNull();
  });

  it("kept ORIGINAL bytes (retainedUntilStructured) replay as that file, and the raw stays", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const doc = await capture({ file: { bytes, mimeType: "image/png" } });
    await redo(doc);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      sourceDocumentId: doc,
      kind: "file",
      input: {
        file: {
          content: bytes.toString("base64"),
          mimeType: "image/png",
          encoding: "base64",
        },
      },
    });
    expect((await sourceMeta(doc)).retainedUntilStructured).toBe(true);
  });

  it("an agent's replace on a capture with no run is refused before anything is written", async () => {
    const doc = await capture();
    const out = await redo(doc, {
      mode: "replace",
      agentUserId: "agent-1",
      callerContext: ctxOf(A, "agent-1"),
    });
    expect(out).toMatchObject({
      ok: false,
      reason: "replace_is_a_human_decision",
    });
    expect(await sessionCount()).toBe(0);
  });
});
