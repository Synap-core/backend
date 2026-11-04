/**
 * Hub REST — the store-first bulk import doors (finding 51e086d8).
 *
 *   POST /import/unit-uploads      one call mints a BATCH of PUT URLs
 *   POST /import/enqueue-units     one manifest → ONE queued job
 *   GET  /import/units-job/:jobId  the submitter polls it
 *
 * DB-free door tests (the enqueue-corpus test's strategy): an isolated Hono app
 * mounting only these routes, with the queue and the storage signer mocked. The
 * load-bearing claim: 712 recordings cost ONE enqueue request carrying every
 * unit and the submitter's acting context, and 712 files cost ⌈712 / 100⌉ mint
 * requests, never one hub request per unit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

const sendMock = vi.fn(async () => JOB_ID);
const getJobByIdMock = vi.fn();
vi.mock("@synap/jobs", () => ({
  getBoss: () => ({ send: sendMock, getJobById: getJobByIdMock }),
}));

const signMock = vi.fn(
  async (key: string) => `https://storage.test/${key}?sig=1`
);
vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/storage")>()),
  storage: { getSignedUploadUrl: (key: string) => signMock(key) },
}));

const grantDenialMock = vi.fn(async (): Promise<string | null> => null);
vi.mock("../../../utils/grant-write-check.js", () => ({
  grantWriteDenial: (...a: unknown[]) => grantDenialMock(...(a as [])),
}));

const resolveActingContextMock = vi.fn();
vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    resolveActingContext: (...args: unknown[]) =>
      resolveActingContextMock(...args),
    resolveActorId: async (_a: string | undefined, userId: string) => ({
      actorId: userId,
    }),
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerImportUnitsRoutes } from "./import-units.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(scopes = ["hub-protocol.write", "hub-protocol.read"]) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", scopes);
    c.set("agentUserId", AGENT_ID);
    c.set("sessionId", "66666666-6666-4666-8666-666666666666");
    await next();
  });
  registerImportUnitsRoutes(app);
  return app;
}

const post = (app: HubHono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function units(n: number, withToken = false) {
  return Array.from({ length: n }, (_, i) => ({
    key: `superwhisper:${1700000000 + i}`,
    title: `Voice note ${i}`,
    content: `transcript ${i}`,
    properties: { source: "superwhisper", recordingId: String(i) },
    ...(withToken
      ? {
          uploadToken: `imports/${USER_ID}/${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000/output.wav`,
        }
      : {}),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockResolvedValue(JOB_ID);
  grantDenialMock.mockResolvedValue(null);
  resolveActingContextMock.mockResolvedValue({
    ok: true,
    userId: USER_ID,
    workspaceId: null,
    role: "owner",
  });
});

describe("POST /import/enqueue-units — one manifest, one job", () => {
  it("queues 712 units as ONE job carrying every unit and the submitter's context", async () => {
    const app = buildApp();
    const res = await post(app, "/import/enqueue-units", {
      units: units(712, true),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      queued: true,
      jobId: JOB_ID,
      unitCount: 712,
    });
    // ONE send, onto the import-units queue — never one request per unit.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [queue, payload] = sendMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown> & { units: Array<Record<string, unknown>> },
    ];
    expect(queue).toBe("import-units");
    expect(payload.units).toHaveLength(712);
    expect(payload.units[0]).toMatchObject({
      key: "superwhisper:1700000000",
      title: "Voice note 0",
      profileSlug: "note",
      content: "transcript 0",
    });
    expect(payload.units[0]!.uploadToken).toMatch(/^imports\//);
    // The acting context the job replays per unit (governed as the request).
    expect(payload).toMatchObject({
      userId: USER_ID,
      workspaceId: null,
      source: "cli",
      scopes: ["hub-protocol.write", "hub-protocol.read"],
      agentUserId: AGENT_ID,
      sessionId: "66666666-6666-4666-8666-666666666666",
    });
    expect(payload).toHaveProperty("grant");
  });

  it("checks the key's grant before queueing, and refuses what it denies (403, nothing queued)", async () => {
    grantDenialMock.mockResolvedValueOnce(
      "This key's grant does not allow entity.create"
    );
    const res = await post(buildApp(), "/import/enqueue-units", {
      units: units(3),
    });
    expect(res.status).toBe(403);
    expect(grantDenialMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "entity",
        action: "create",
        data: { profileSlug: "note" },
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refuses an upload token minted for another user (400, nothing queued)", async () => {
    const res = await post(buildApp(), "/import/enqueue-units", {
      units: [
        {
          key: "superwhisper:1",
          title: "A",
          uploadToken: `imports/${OTHER_USER_ID}/00000000-0000-4000-8000-000000000000/output.wav`,
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refuses a manifest whose keys repeat (400)", async () => {
    const res = await post(buildApp(), "/import/enqueue-units", {
      units: [
        { key: "k", title: "A" },
        { key: "k", title: "B" },
      ],
    });
    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("needs the write scope", async () => {
    const res = await post(
      buildApp(["hub-protocol.read"]),
      "/import/enqueue-units",
      {
        units: units(1),
      }
    );
    expect(res.status).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("POST /import/unit-uploads — a batch of URLs per request", () => {
  const wav = (i: number) => ({
    filename: "output.wav",
    mimeType: "audio/wav",
    size: 1_000_000 + i,
  });

  it("mints 100 PUT URLs in ONE request, each under the caller's import prefix", async () => {
    const res = await post(buildApp(), "/import/unit-uploads", {
      files: Array.from({ length: 100 }, (_, i) => wav(i)),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploads: Array<{
        uploadToken: string;
        uploadUrl: string;
        method: string;
      }>;
    };
    expect(body.uploads).toHaveLength(100);
    expect(new Set(body.uploads.map((u) => u.uploadToken)).size).toBe(100);
    for (const u of body.uploads) {
      expect(u.method).toBe("PUT");
      expect(u.uploadToken.startsWith(`imports/${USER_ID}/`)).toBe(true);
    }
    expect(grantDenialMock).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "document", action: "create" })
    );
  });

  it("refuses more than 100 files in one call (400)", async () => {
    const res = await post(buildApp(), "/import/unit-uploads", {
      files: Array.from({ length: 101 }, (_, i) => wav(i)),
    });
    expect(res.status).toBe(400);
    expect(signMock).not.toHaveBeenCalled();
  });

  it("refuses the whole batch when one file is over its type's cap (413), naming it", async () => {
    const res = await post(buildApp(), "/import/unit-uploads", {
      files: [wav(0), { ...wav(1), size: 101 * 1024 * 1024 }],
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /^files\[1\]/
    );
    expect(signMock).not.toHaveBeenCalled();
  });
});

describe("GET /import/units-job/:jobId — only the submitter reads it", () => {
  it("returns the per-unit outcome to the submitter", async () => {
    const output = {
      total: 2,
      stored: 1,
      proposed: 1,
      failed: 0,
      results: {
        "superwhisper:1": {
          status: "stored",
          entityId: "e1",
          audio: true,
          audioSkippedReason: null,
        },
        "superwhisper:2": {
          status: "proposed",
          proposalId: "p1",
          audioSkippedReason: "entity_proposed",
        },
      },
    };
    getJobByIdMock.mockResolvedValue({
      state: "completed",
      data: { userId: USER_ID, grant: { scopes: [] }, units: [] },
      createdOn: null,
      completedOn: null,
      output,
    });
    const res = await buildApp().request(`/import/units-job/${JOB_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      jobId: JOB_ID,
      state: "completed",
      createdOn: null,
      completedOn: null,
      output,
    });
    expect(getJobByIdMock).toHaveBeenCalledWith("import-units", JOB_ID, {
      includeArchive: true,
    });
  });

  it("answers 404 for another user's job (no existence oracle)", async () => {
    getJobByIdMock.mockResolvedValue({
      state: "completed",
      data: { userId: OTHER_USER_ID },
    });
    const res = await buildApp().request(`/import/units-job/${JOB_ID}`);
    expect(res.status).toBe(404);
  });

  it("answers 400 for a malformed id without reaching the queue", async () => {
    const res = await buildApp().request("/import/units-job/not-a-uuid");
    expect(res.status).toBe(400);
    expect(getJobByIdMock).not.toHaveBeenCalled();
  });
});
