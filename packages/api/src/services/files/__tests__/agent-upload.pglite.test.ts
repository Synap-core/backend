/**
 * Agent upload lane (D10/L1) — `requestAgentUpload` → PUT → `finalizeAgentUpload`.
 *
 * Driven through the REAL presign lane (`requestPresignedUpload` /
 * `storeDocumentFromPresignedUpload`), the REAL write floor
 * (`canWriteWorkspace` → `assertWorkspaceWrite`), the REAL rate limiter and the
 * REAL body door (`EntityBodyService.setBody`) on PGlite. Object storage is
 * stubbed at the provider boundary (`@synap/storage`).
 *
 * The two governed doors downstream of finalize —
 * `createGovernedFileEntityForStoredDocument` and
 * `gateAndAttachStagedSourceBlob` — are the SAME functions `synap_store_file`
 * calls and are covered by their own suites; here they are spies, and the
 * assertions pin what this lane hands them (agent identity, session, workspace,
 * the stored document). What this CANNOT see: production Postgres (tables are
 * generated from the Drizzle definitions without FKs/NOT NULL/enums).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getSignedUploadUrl: vi.fn(),
  getMetadata: vi.fn(),
  deleteObj: vi.fn(),
  createGoverned: vi.fn(),
  gateAttach: vi.fn(),
  recordArtifact: vi.fn(),
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
    db: drizzle(client, { schema }),
    // The actual singleton is bound to the real Postgres; events are not under test.
    eventRepository: { append: async () => ({}) },
  };
});

vi.mock("@synap/storage", () => {
  class StorageUploadUnavailableError extends Error {
    readonly code = "STORAGE_UPLOAD_UNAVAILABLE";
  }
  return {
    StorageUploadUnavailableError,
    storage: {
      getSignedUploadUrl: h.getSignedUploadUrl,
      getMetadata: h.getMetadata,
      delete: h.deleteObj,
      objectUrl: async (k: string) => `https://pod.example/synap-storage/${k}`,
    },
  };
});

vi.mock("../../../routers/create-governed-file-entity.js", () => ({
  createGovernedFileEntityForStoredDocument: h.createGoverned,
}));
vi.mock("../../../utils/store-entity-source-blob.js", () => ({
  gateAndAttachStagedSourceBlob: h.gateAttach,
}));
vi.mock("../../focus-sessions/record-session-artifact.js", () => ({
  recordSessionArtifact: h.recordArtifact,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  requestAgentUpload,
  finalizeAgentUpload,
  AGENT_UPLOAD_TOKEN_TTL_SECONDS,
} from "../agent-upload.js";

const USER = "user-owner";
const VIEWER = "user-viewer";
const WS = randomUUID();
const OTHER_WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    // The body door inserts `documents` with `id default` — give uuid keys one.
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor'),($4,$2,$5,'viewer'),($6,$7,$3,'editor')`,
    [randomUUID(), WS, USER, randomUUID(), VIEWER, randomUUID(), OTHER_WS]
  );
});

let agent: string;
beforeEach(() => {
  vi.clearAllMocks();
  // A fresh agent per test: the files limiter (30/min) is keyed on it.
  agent = `agent-${randomUUID()}`;
  h.getSignedUploadUrl.mockImplementation(
    async (key: string) =>
      `https://pod.example/synap-storage/${key}?X-Amz-Signature=x`
  );
  h.deleteObj.mockResolvedValue(undefined);
  h.createGoverned.mockImplementation(
    async (stored: { documentId: string }) => ({
      status: "created",
      fileEntityId: "entity-new",
      documentId: stored.documentId,
    })
  );
  h.recordArtifact.mockResolvedValue(null);
});

const request = (over: Record<string, unknown> = {}) =>
  requestAgentUpload({
    userId: USER,
    agentUserId: agent,
    workspaceId: WS,
    filename: "deck.html",
    mimeType: "text/html",
    size: 2048,
    sessionId: "session-1",
    ...over,
  });

async function ticket(over: Record<string, unknown> = {}) {
  const t = await request(over);
  if (!t.ok) throw new Error(`request refused: ${t.code}`);
  return t;
}

/** The storage key the presign lane signed for this ticket. */
const signedKey = () => h.getSignedUploadUrl.mock.calls.at(-1)![0] as string;

const finalize = (uploadToken: string, over: Record<string, unknown> = {}) =>
  finalizeAgentUpload({
    userId: USER,
    agentUserId: agent,
    scopes: ["mcp.write"],
    uploadToken,
    ...over,
  });

describe("requestAgentUpload", () => {
  it("presigns through the shared lane; the token wraps the key but is not it", async () => {
    const t = await ticket();
    const key = signedKey();
    expect(key).toMatch(
      new RegExp(`^files/${WS}/uploads/${USER}/[0-9a-f-]{36}/deck\\.html$`)
    );
    expect(h.getSignedUploadUrl).toHaveBeenCalledWith(key, {
      contentType: "text/html",
      contentLength: 2048,
      expiresIn: 900,
    });
    expect(t.uploadUrl).toContain(key);
    expect(t.headers).toEqual({ "Content-Type": "text/html" });
    expect(t.method).toBe("PUT");
    expect(t.uploadToken).not.toBe(key);
    expect(t.uploadToken.startsWith("sau1.")).toBe(true);
  });

  it("refuses a viewer (write floor) and a missing workspace before signing", async () => {
    expect(await request({ userId: VIEWER })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await request({ workspaceId: undefined })).toMatchObject({
      ok: false,
      status: 400,
      code: "WORKSPACE_REQUIRED",
    });
    expect(h.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("passes the lane's own refusals through (mime, size cap)", async () => {
    expect(
      await request({ mimeType: "application/x-msdownload" })
    ).toMatchObject({ ok: false, status: 415 });
    expect(
      await request({ mimeType: "video/mp4", size: 501 * 1024 * 1024 })
    ).toMatchObject({ ok: false, status: 413 });
  });
});

describe("finalizeAgentUpload — the token", () => {
  it("refuses another agent, another user, a tampered token and a raw key", async () => {
    const t = await ticket();
    expect(
      await finalize(t.uploadToken, { agentUserId: "agent-other" })
    ).toMatchObject({
      ok: false,
      status: 403,
      code: "UPLOAD_NOT_YOURS",
    });
    expect(await finalize(t.uploadToken, { userId: VIEWER })).toMatchObject({
      ok: false,
      status: 403,
      code: "UPLOAD_NOT_YOURS",
    });
    const [p, payload, sig] = t.uploadToken.split(".");
    const forged = Buffer.from(payload!, "base64url")
      .toString("utf8")
      .replace(agent, "agent-other");
    expect(
      await finalize(
        `${p}.${Buffer.from(forged).toString("base64url")}.${sig}`,
        { agentUserId: "agent-other" }
      )
    ).toMatchObject({ ok: false, status: 400, code: "INVALID_UPLOAD_TOKEN" });
    expect(await finalize(signedKey())).toMatchObject({
      ok: false,
      status: 400,
      code: "INVALID_UPLOAD_TOKEN",
    });
    expect(h.getMetadata).not.toHaveBeenCalled();
  });

  it("expires", async () => {
    const t = await ticket();
    const now = Date.now();
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValue(now + AGENT_UPLOAD_TOKEN_TTL_SECONDS * 1000 + 1);
    try {
      expect(await finalize(t.uploadToken)).toMatchObject({
        ok: false,
        status: 410,
        code: "UPLOAD_TOKEN_EXPIRED",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("re-checks key confinement on the bound workspace", async () => {
    const t = await ticket();
    expect(
      await finalize(t.uploadToken, {
        keyType: "service",
        keyWorkspaceId: OTHER_WS,
      })
    ).toMatchObject({ ok: false, status: 403 });
    expect(h.getMetadata).not.toHaveBeenCalled();
  });
});

describe("finalizeAgentUpload — store_file's governance", () => {
  it("adopts the PUT object, then mints the entity through the governed door as the agent, in the requested session", async () => {
    const t = await ticket();
    const key = signedKey();
    h.getMetadata.mockResolvedValueOnce({
      size: 2048,
      contentType: "text/html",
    });

    const r = await finalize(t.uploadToken, { title: "Q3 deck" });

    expect(r).toMatchObject({
      ok: true,
      status: "created",
      fileEntityId: "entity-new",
    });
    const { rows } = await q(
      `select id, storage_key, mime_type, workspace_id from documents where storage_key = $1`,
      [key]
    );
    expect(rows).toHaveLength(1);
    const doc = rows[0] as {
      id: string;
      mime_type: string;
      workspace_id: string;
    };
    expect(doc).toMatchObject({ mime_type: "text/html", workspace_id: WS });
    expect(h.createGoverned).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: doc.id, storageKey: key }),
      expect.objectContaining({
        userId: USER,
        agentUserId: agent,
        workspaceId: WS,
        sessionId: "session-1",
        mimeType: "text/html",
        filename: "deck.html",
        title: "Q3 deck",
        scopes: ["mcp.write"],
      })
    );
    expect(h.recordArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        kind: "entity",
        refId: "entity-new",
        agentUserId: agent,
      })
    );
  });

  it("a proposed create is a normal outcome and records no artifact", async () => {
    const t = await ticket();
    h.getMetadata.mockResolvedValueOnce({
      size: 2048,
      contentType: "text/html",
    });
    h.createGoverned.mockResolvedValueOnce({
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "/r/prop-1",
      documentId: "d",
    });
    expect(await finalize(t.uploadToken)).toMatchObject({
      ok: true,
      status: "proposed",
      proposalId: "prop-1",
    });
    expect(h.recordArtifact).not.toHaveBeenCalled();
  });

  it("attach mode goes through the source-file gate with the stored document", async () => {
    const t = await ticket({ filename: "clip.mp4", mimeType: "video/mp4" });
    const key = signedKey();
    h.getMetadata.mockResolvedValueOnce({
      size: 2048,
      contentType: "video/mp4",
    });
    h.gateAttach.mockImplementationOnce(async (input: { staged: object }) => ({
      status: "stored",
      ...input.staged,
    }));

    const r = await finalize(t.uploadToken, {
      attachToEntityId: "entity-target",
      sessionId: "session-explicit",
      expectedLabel: "Demo clip",
    });

    expect(r).toMatchObject({
      ok: true,
      status: "attached",
      entityId: "entity-target",
    });
    expect(h.createGoverned).not.toHaveBeenCalled();
    expect(h.gateAttach).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        entityId: "entity-target",
        workspaceId: WS,
        sessionId: "session-explicit",
        expectedLabel: "Demo clip",
        staged: expect.objectContaining({
          storageKey: key,
          mimeType: "video/mp4",
          filename: "clip.mp4",
          size: 2048,
        }),
      })
    );
    expect(h.recordArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "document",
        sessionId: "session-explicit",
      })
    );
  });

  it("a document claimed by a source-file attach is finished — a second finalize is 409", async () => {
    const t = await ticket({ filename: "a.pdf", mimeType: "application/pdf" });
    h.getMetadata.mockResolvedValueOnce({
      size: 10,
      contentType: "application/pdf",
    });
    // The gate parks the attach: the pending proposal carries data.sourceFile.
    h.gateAttach.mockImplementationOnce(
      async (input: { staged: { documentId: string } }) => {
        await q(
          `insert into proposals (id, status, data) values ($1,'pending',$2)`,
          [randomUUID(), JSON.stringify({ id: "e1", sourceFile: input.staged })]
        );
        return {
          status: "proposed",
          proposalId: "p1",
          proposalType: "entity.update",
          reviewUrl: "/r/p1",
          staged: input.staged,
        };
      }
    );
    expect(
      await finalize(t.uploadToken, { attachToEntityId: "e1" })
    ).toMatchObject({ ok: true, status: "proposed", proposalId: "p1" });

    expect(await finalize(t.uploadToken)).toMatchObject({
      ok: false,
      status: 409,
      code: "ALREADY_FINALIZED",
    });
    expect(h.createGoverned).not.toHaveBeenCalled();
  });

  it("an attach that left entity.document_id alone still claims via sourceFileDocumentId", async () => {
    const t = await ticket({ filename: "b.pdf", mimeType: "application/pdf" });
    h.getMetadata.mockResolvedValueOnce({
      size: 10,
      contentType: "application/pdf",
    });
    h.gateAttach.mockImplementationOnce(
      async (input: { staged: { documentId: string } }) => {
        await q(
          `insert into entities (id, user_id, title, document_id, properties) values ($1,$2,'Has a body',$4,$3)`,
          [
            randomUUID(),
            USER,
            JSON.stringify({ sourceFileDocumentId: input.staged.documentId }),
            randomUUID(), // an existing body: the attach left document_id alone
          ]
        );
        return { status: "stored", ...input.staged };
      }
    );
    expect(
      await finalize(t.uploadToken, { attachToEntityId: "e2" })
    ).toMatchObject({ ok: true, status: "attached" });

    expect(await finalize(t.uploadToken)).toMatchObject({
      ok: false,
      status: 409,
      code: "ALREADY_FINALIZED",
    });
  });
});
