/**
 * Hub Protocol REST — POST /import/enqueue-corpus + GET /import/corpus-job/:jobId
 *
 * The background corpus door: the CLI speaks Hub REST, and before this route
 * Hub REST exposed only the PER-FILE synchronous `/import/analyze` — so a
 * many-file corpus ran N synchronous requests against the request timeout
 * instead of one chunked background job.
 *
 * These are DB-free door tests. They pin the two things that are provable
 * without Postgres and that this repo has been bitten by twice today:
 *
 *   1. a malformed `jobId` is a 400 at the door, NOT a 500 — the column is a
 *      `uuid`, so an unchecked id reaches Postgres, throws, and the handler's
 *      catch-all reports a CLIENT mistake as a SERVER fault;
 *   2. the route is a THIN door — it enqueues onto the same `import-corpus`
 *      queue with the same payload as `trpc.import.enqueueLargeImport` and
 *      re-derives no chunking of its own.
 *
 * Strategy mirrors links.test.ts: an isolated Hono app mounting only
 * `registerCaptureRoutes`, with the heavy dependencies mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const sendMock = vi.fn(async () => JOB_ID);
const getJobByIdMock = vi.fn();

vi.mock("@synap/jobs", () => ({
  getBoss: () => ({ send: sendMock, getJobById: getJobByIdMock }),
}));

vi.mock("@synap/jobs/workers/import-corpus-worker.js", () => ({
  IMPORT_CORPUS_QUEUE: "import-corpus",
}));

// NOTE: `@synap/database` is deliberately NOT mocked. Its barrel is re-exported
// through the access registry, so a narrow stub breaks module load; the real
// module is import-safe (no connection until a query runs) and these two routes
// never issue one.

const resolveActingContextMock = vi.fn();
const getConfinedWorkspaceMock = vi.fn(
  (_c: unknown, ws?: string) => ws ?? null
);

vi.mock("../confine-workspace.js", () => ({
  getConfinedWorkspace: (...args: unknown[]) =>
    getConfinedWorkspaceMock(...(args as [unknown, string?])),
}));

vi.mock("./_shared.js", async (importOriginal) => {
  // Keep the REAL isUuid / uuidPathParam — they are the thing under test.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    resolveActingContext: (...args: unknown[]) =>
      resolveActingContextMock(...args),
  };
});

// Imports must come AFTER vi.mock (ESM hoisting handles this).
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerCaptureRoutes } from "./capture.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildTestApp(
  scopes: string[] = ["hub-protocol.write", "hub-protocol.read"]
): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", scopes);
    await next();
  });
  registerCaptureRoutes(app);
  return app;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    source: "markdown",
    items: [
      { path: "notes/one.md", content: "Alice runs the Berlin office." },
      { path: "notes/two.md", content: "Bob joined in March." },
    ],
    ...overrides,
  };
}

async function postEnqueue(app: HubHono, body: unknown) {
  return app.request("/import/enqueue-corpus", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockResolvedValue(JOB_ID);
  resolveActingContextMock.mockResolvedValue({
    ok: true,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: "editor",
  });
});

describe("GET /import/corpus-job/:jobId — input validation", () => {
  it("rejects a malformed jobId with 400 at the door, never reaching pg-boss", async () => {
    const app = buildTestApp();
    const res = await app.request("/import/corpus-job/not-a-uuid");

    expect(res.status).toBe(400);
    // The load-bearing assertion: a client mistake must not become a 500. It
    // only stays a 400 if the shape check happens BEFORE the uuid query.
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it("rejects a truncated (display-shortened) uuid with 400", async () => {
    const app = buildTestApp();
    const res = await app.request(`/import/corpus-job/${JOB_ID.slice(0, 8)}`);

    expect(res.status).toBe(400);
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });

  it("accepts a well-formed uuid and forwards it to the queue lookup", async () => {
    getJobByIdMock.mockResolvedValue({
      state: "completed",
      data: { userId: USER_ID },
      createdOn: null,
      completedOn: null,
    });

    const app = buildTestApp();
    const res = await app.request(`/import/corpus-job/${JOB_ID}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      jobId: JOB_ID,
      state: "completed",
    });
    expect(getJobByIdMock).toHaveBeenCalledWith("import-corpus", JOB_ID, {
      includeArchive: true,
    });
  });

  it("returns the job output — the file-level outcome the CLI reports", async () => {
    // The worker's ImportCorpusResult, as pg-boss stored it. Without this field
    // on the wire the poller sees only `state: "completed"`, so a run that
    // dropped 2 of 3 files is indistinguishable from a clean one.
    const output = {
      proposalId: "prop-1",
      workspaceId: WORKSPACE_ID,
      filesProcessed: 1,
      filesFailed: 2,
      qualityScore: 41,
      findings: [
        {
          id: "files-failed",
          severity: "warn",
          message: "2 file(s) failed deep structure (timeouts/empty)",
        },
      ],
    };
    getJobByIdMock.mockResolvedValue({
      state: "completed",
      data: { userId: USER_ID },
      createdOn: null,
      completedOn: null,
      output,
    });

    const app = buildTestApp();
    const res = await app.request(`/import/corpus-job/${JOB_ID}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      jobId: JOB_ID,
      state: "completed",
      output,
    });
  });

  it("reports a missing output as null (older pod / unfinished job), never as success", async () => {
    getJobByIdMock.mockResolvedValue({
      state: "active",
      data: { userId: USER_ID },
      createdOn: null,
      completedOn: null,
    });

    const app = buildTestApp();
    const res = await app.request(`/import/corpus-job/${JOB_ID}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.output).toBeNull();
    // Additive, not replacing: the pre-existing fields must survive.
    expect(body).toMatchObject({ jobId: JOB_ID, state: "active" });
  });

  it("404s another user's job without revealing that it exists", async () => {
    getJobByIdMock.mockResolvedValue({
      state: "active",
      data: { userId: OTHER_USER_ID },
    });

    const app = buildTestApp();
    const res = await app.request(`/import/corpus-job/${JOB_ID}`);

    expect(res.status).toBe(404);
  });

  it("requires the read scope", async () => {
    const app = buildTestApp([]);
    const res = await app.request(`/import/corpus-job/${JOB_ID}`);

    expect(res.status).toBe(403);
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });
});

describe("POST /import/enqueue-corpus — input validation", () => {
  it("rejects a non-uuid workspaceId with 400, not 500", async () => {
    const app = buildTestApp();
    const res = await postEnqueue(app, validBody({ workspaceId: "nope" }));

    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed JSON body with 400", async () => {
    const app = buildTestApp();
    const res = await app.request("/import/enqueue-corpus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown source with 400", async () => {
    const app = buildTestApp();
    const res = await postEnqueue(app, validBody({ source: "notion" }));

    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects an empty item list with 400", async () => {
    const app = buildTestApp();
    const res = await postEnqueue(app, validBody({ items: [] }));

    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("enforces the shared aggregate byte budget (schema reused from the tRPC door)", async () => {
    // 260 × 200_000 = 52_000_000 chars ≈ 49.6MiB — over the 48MiB
    // (50_331_648 char) cap declared once in routers/import.ts. Proves the
    // REST door validates through the SAME schema rather than a re-declared
    // copy that could drift.
    const chunk = "x".repeat(200_000);
    const items = Array.from({ length: 260 }, (_, i) => ({
      path: `big/${i}.md`,
      content: chunk,
    }));

    const app = buildTestApp();
    const res = await postEnqueue(app, validBody({ items }));

    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("requires a write scope", async () => {
    const app = buildTestApp(["hub-protocol.read"]);
    const res = await postEnqueue(app, validBody());

    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("POST /import/enqueue-corpus — thin door onto the existing background path", () => {
  it("enqueues the SAME payload trpc.import.enqueueLargeImport sends and returns 202 + jobId", async () => {
    const app = buildTestApp();
    const res = await postEnqueue(app, validBody());

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      queued: true,
      jobId: JOB_ID,
      itemCount: 2,
      workspaceId: WORKSPACE_ID,
    });

    // Payload parity with routers/import.ts → ImportCorpusPayload. The route
    // must not re-derive chunking or dedup — it hands the raw corpus over.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith("import-corpus", {
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      source: "markdown",
      items: validBody().items,
    });
  });

  it("stamps the workspace resolved by the acting context, never the raw body value", async () => {
    // A workspace-bound service key is clamped by getConfinedWorkspace and the
    // acting context; a body-supplied workspaceId must not win.
    const CONFINED = "33333333-3333-4333-8333-333333333333";
    getConfinedWorkspaceMock.mockReturnValue(CONFINED);
    resolveActingContextMock.mockResolvedValue({
      ok: true,
      userId: USER_ID,
      workspaceId: CONFINED,
      role: "editor",
    });

    const app = buildTestApp();
    const res = await postEnqueue(app, validBody());

    expect(res.status).toBe(202);
    expect(sendMock).toHaveBeenCalledWith(
      "import-corpus",
      expect.objectContaining({ workspaceId: CONFINED })
    );
  });

  it("propagates an acting-context rejection instead of enqueueing", async () => {
    resolveActingContextMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "userId does not match the authenticated session",
    });

    const app = buildTestApp();
    const res = await postEnqueue(app, validBody({ userId: OTHER_USER_ID }));

    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
