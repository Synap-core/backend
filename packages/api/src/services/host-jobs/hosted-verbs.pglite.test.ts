/**
 * Hosted verbs end to end on PGlite (plan b647769e §3.2, plan 64072312 U8):
 * the real `computer.run_recipe` handler queues, the real host-jobs routes
 * lease, upload and finish, the real runs read lists the run. The file doors
 * (`readableFileEntity`, `signFileEntityUrl`, `requestAgentUpload`,
 * `finalizeAgentUpload`) and the room notice are stand-ins that record what
 * they were asked, so each case asserts the VALUE that reaches them:
 *
 *   - queue: refused with the next step when the tool is missing, its check
 *     failed, the recipe is unknown, a value does not fill it, or an input file
 *     is not the person's to read; otherwise ONE `verb` job on the
 *     installation of the chosen computer, answered `{status:"queued"}`, and
 *     the asking session hears it;
 *   - lease: a run waits while a lifecycle job of its installation is open,
 *     then carries each input file as a link signed for the job's owner; a
 *     file no longer readable fails the run with the reason, never a lease;
 *   - uploads: only a held `verb` job, minted for the REQUESTER (person,
 *     agent, session, space), never for the computer;
 *   - finish: each uploaded output is stored as the requester's file and named
 *     on the evidence; the session hears which file; the runs feed lists the
 *     run as completed, and a queued one as running, never as done.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  notices: [] as Array<{ sessionId: string; content: string }>,
  readable: new Set<string>(),
  signedFor: [] as Array<{ userId: string; id: string; ttl?: number }>,
  uploadAsks: [] as Array<Record<string, unknown>>,
  finalized: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

vi.mock("../agent-dispatch/binding-call.js", () => ({
  postSessionNotice: async (sessionId: string, content: string) => {
    h.notices.push({ sessionId, content });
    return true;
  },
}));

vi.mock("../../routers/file-upload.js", () => ({
  readableFileEntity: async (userId: string, id: string) =>
    h.readable.has(`${userId}:${id}`)
      ? {
          ok: true,
          entity: {
            id,
            storageKey: `k/${id}`,
            title: "My clip.mp4",
            mimeType: "video/mp4",
            size: 1234,
          },
        }
      : { ok: false, status: 403, error: "Forbidden" },
  signFileEntityUrl: async (
    userId: string,
    id: string,
    opts: { expiresInSeconds?: number } = {}
  ) => {
    h.signedFor.push({ userId, id, ttl: opts.expiresInSeconds });
    if (!h.readable.has(`${userId}:${id}`))
      return { ok: false, status: 404, error: "File entity not found" };
    return {
      ok: true,
      body: {
        url: `https://s3.test/${id}?sig=1`,
        expiresAt: "2026-11-09T20:00:00.000Z",
        mimeType: "video/mp4",
      },
      entity: { id, title: "My clip.mp4", size: 1234 },
    };
  },
}));

vi.mock("../files/agent-upload.js", () => ({
  requestAgentUpload: async (p: Record<string, unknown>) => {
    h.uploadAsks.push(p);
    return {
      ok: true,
      uploadUrl: "https://s3.test/put",
      method: "PUT",
      headers: { "Content-Type": p.mimeType },
      uploadToken: `tok-${String(p.filename)}`,
      expiresAt: "2026-11-09T20:00:00.000Z",
      maxBytes: 1e9,
    };
  },
  finalizeAgentUpload: async (p: Record<string, unknown>) => {
    h.finalized.push(p);
    return {
      ok: true,
      status: "created",
      fileEntityId: `file-${String(p.uploadToken)}`,
      documentId: "doc-1",
    };
  },
}));

vi.mock("../installations/request-installation.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listPersonsComputers: async (personId: string) =>
      personId === "person-a"
        ? [
            {
              id: "machine-mac",
              ownerUserId: "person-a",
              name: "MacBook-Pro",
              os: "darwin",
              arch: "arm64",
              installsFromPod: true,
            },
            {
              id: "machine-devbox",
              ownerUserId: "person-a",
              name: "devbox",
              os: "linux",
              arch: "x64",
              installsFromPod: true,
            },
          ]
        : [],
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerHostJobsRoutes } from "../../routers/hub-protocol/rest/host-jobs.js";
import { BUILTIN_VERBS } from "../capabilities/builtin-verbs.js";
import {
  installedRecipesFor,
  isQueuedHostVerbResult,
  listHostVerbRunsForFeed,
} from "./hosted-verbs.js";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = "person-a";
const MAC = "machine-mac";
const DEVBOX = "machine-devbox";
const AGENT = "agent-1";
const SESSION = randomUUID();
const SPACE = randomUUID();
const INST_MAC = randomUUID();
const INST_DEVBOX = randomUUID();
const CLIP = randomUUID();
const NOT_MINE = randomUUID();

const LOUDNORM = {
  name: "loudness-normalize",
  description: "Two-pass loudness normalisation.",
  params: {
    in: { type: "file", description: "The video.", required: true },
    out: { type: "output", description: "The result.", required: true },
    target: { type: "number", description: "LUFS.", default: -14 },
  },
  steps: [
    {
      program: "python",
      args: [
        "{script:loudnorm2pass.py}",
        "{bin:ffmpeg}",
        "{in}",
        "{out}",
        "{target}",
      ],
    },
  ],
  scripts: [
    { name: "loudnorm2pass.py", sha256: "0".repeat(64), source: "print(1)\n" },
  ],
  gotchas: ["Normalise last."],
};

const run = BUILTIN_VERBS["computer.run_recipe"]!;
const ctx = {
  userId: PERSON,
  workspaceId: SPACE,
  agentUserId: AGENT,
  sessionId: SESSION,
  verbId: null,
};

const mac = (): HubHono => {
  const app = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write", "host.runner"]);
    c.set("userId", PERSON);
    c.set("agentUserId", MAC);
    await next();
  });
  registerHostJobsRoutes(app);
  return app;
};
const post = (path: string, body: unknown) =>
  mac().request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

type Leased = {
  id: string;
  kind: string;
  leaseId: string;
  parameters: Record<string, unknown>;
  inputs?: Record<
    string,
    Array<{ fileEntityId: string; url: string; name: string }>
  >;
};
async function lease(): Promise<Leased | null> {
  const res = await post("/host-jobs/lease", {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { job: Leased | null }).job;
}

async function setInstallation(
  id: string,
  fields: { status: string; verifyOk: boolean | null }
) {
  await q(
    `UPDATE installations SET status = $2,
       verified_at = CASE WHEN $3::boolean IS NULL THEN NULL ELSE now() END,
       health = CASE WHEN $3::boolean IS NULL THEN NULL
                     ELSE jsonb_build_object('verify', jsonb_build_object('ok', $3::boolean, 'exitCode', 0)) END
     WHERE id = $1`,
    [id, fields.status, fields.verifyOk]
  );
}

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `INSERT INTO users (id, email, name, agent_type, created_by_user_id) VALUES
      ($1, 'a@x', 'person', NULL, NULL),
      ($2, 'm@x', 'MacBook-Pro', 'machine', $1),
      ($3, 'd@x', 'devbox', 'machine', $1)`,
    [PERSON, MAC, DEVBOX]
  );
  const manifest = JSON.stringify({ recipes: [LOUDNORM] });
  await q(
    `INSERT INTO installations (id, user_id, workspace_id, kind, capability_key, machine_user_id, status, manifest, digests)
     VALUES ($1, $3, $4, 'tool', 'media-ffmpeg', $5, 'installed', $6::jsonb, '{}'::jsonb),
            ($2, $3, $4, 'tool', 'media-ffmpeg', $7, 'installed', $6::jsonb, '{}'::jsonb)`,
    [INST_MAC, INST_DEVBOX, PERSON, SPACE, MAC, manifest, DEVBOX]
  );
  h.readable.add(`${PERSON}:${CLIP}`);
}, 60_000);

beforeEach(async () => {
  h.notices.length = 0;
  h.signedFor.length = 0;
  h.uploadAsks.length = 0;
  h.finalized.length = 0;
  await q(`DELETE FROM host_jobs`);
  await setInstallation(INST_MAC, { status: "installed", verifyOk: true });
  await setInstallation(INST_DEVBOX, { status: "failed", verifyOk: false });
});

const ask = (over: Record<string, unknown> = {}) => ({
  capability: "media-ffmpeg",
  recipe: "loudness-normalize",
  params: { in: CLIP, out: "clip-loud.mp4", target: -16 },
  ...over,
});

/** A refusal (`verb-refusal.ts`): its code, its class, its sentence. */
const refusal = (code: string, errorClass: string, sentence: RegExp) => ({
  name: "VerbRefusal",
  code,
  errorClass,
  message: expect.stringMatching(sentence),
});

describe("computer.run_recipe — the ask", () => {
  it("refuses with the next step when the tool is on no computer", async () => {
    await expect(
      run(ask({ capability: "media-transcribe" }), ctx)
    ).rejects.toMatchObject(
      refusal("NOT_INSTALLED", "target_missing", /synap_request_installation/)
    );
  });

  it("never sends a run to a computer whose check failed", async () => {
    await expect(run(ask({ computer: "devbox" }), ctx)).rejects.toMatchObject(
      refusal("NOT_RUNNABLE", "conflict", /devbox.*repair it first/)
    );
    await setInstallation(INST_MAC, { status: "failed", verifyOk: false });
    await expect(run(ask(), ctx)).rejects.toMatchObject({
      code: "NOT_RUNNABLE",
    });
    expect((await q(`SELECT 1 FROM host_jobs`)).rows).toHaveLength(0);
  });

  it("refuses an unknown recipe with the list, and values that do not fill it", async () => {
    await expect(run(ask({ recipe: "range-cut" }), ctx)).rejects.toMatchObject(
      refusal(
        "UNKNOWN_RECIPE",
        "target_missing",
        /approved version has no recipe "range-cut".*action "update".*loudness-normalize/
      )
    );
    await expect(
      run(ask({ params: { in: CLIP, out: "../../x.mp4" } }), ctx)
    ).rejects.toMatchObject({ code: "BAD_PARAMS", errorClass: "validation" });
    await expect(
      run(ask({ params: { in: NOT_MINE, out: "x.mp4" } }), ctx)
    ).rejects.toMatchObject({
      code: "FILE_NOT_READABLE",
      errorClass: "target_missing",
    });
    expect((await q(`SELECT 1 FROM host_jobs`)).rows).toHaveLength(0);
  });

  it("queues ONE verb job on the chosen computer's installation, and says so", async () => {
    const out = await run(ask(), ctx);
    expect(isQueuedHostVerbResult(out)).toBe(true);
    expect(out).toMatchObject({
      status: "queued",
      computer: { id: MAC, name: "MacBook-Pro" },
      recipe: "loudness-normalize",
    });
    const jobs = await q<Record<string, unknown>>(
      `SELECT kind, installation_id, machine_user_id, user_id, agent_user_id, session_id, workspace_id, spec, parameters, status FROM host_jobs`
    );
    expect(jobs.rows).toEqual([
      expect.objectContaining({
        kind: "verb",
        installation_id: INST_MAC,
        machine_user_id: MAC,
        user_id: PERSON,
        agent_user_id: AGENT,
        session_id: SESSION,
        workspace_id: SPACE,
        status: "queued",
        spec: {
          op: "verb",
          capabilityKey: "media-ffmpeg",
          recipe: "loudness-normalize",
        },
        parameters: { in: CLIP, out: "clip-loud.mp4", target: -16 },
      }),
    ]);
    expect(h.notices).toEqual([
      { sessionId: SESSION, content: expect.stringContaining("MacBook-Pro") },
    ]);
  });
});

/**
 * The person APPROVES an agent's run (proposal c6ba64e6, 2026-11-10): the
 * agent asked for `range-cut`, which the catalog added after media-ffmpeg was
 * approved on that computer. The handler refused with the next step, and the
 * approval recorded "Couldn't apply — an internal error occurred.", class
 * `unknown`, and kept its dispatch claim (Retry could not re-run).
 *
 * Through the REAL approve path after its human gates
 * (`completeProposalApproval` → `dispatchProposalApproval` → the
 * `capability.run` executor → `runResolvedSkill` → the handler), a refusal is
 * recorded on the proposal as its own sentence and class, and the claim is
 * released; an accepted run is approved and queued.
 *
 * Negative control: with `runResolvedSkill` re-throwing a `VerbRefusal`
 * (the catch in execute-capability.ts removed), the refusal case is red: the
 * row reads "an internal error occurred", class `unknown`, claim kept.
 */
describe("approving an agent's computer.run_recipe", () => {
  const SKILL = randomUUID();

  beforeAll(async () => {
    await q(
      `INSERT INTO workspaces (id, owner_id, name) VALUES ($1, $2, 'Builder')`,
      [SPACE, PERSON]
    );
    await q(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [SPACE, PERSON]
    );
    await q(
      `INSERT INTO skills (id, user_id, name, code, kind, scope, status, approved)
       VALUES ($1, $2, 'computer.run_recipe', '', 'builtin', 'pod', 'active', true)`,
      [SKILL, PERSON]
    );
  });

  async function proposeRun(parameters: Record<string, unknown>) {
    const id = randomUUID();
    await q(
      `INSERT INTO proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, agent_user_id)
       VALUES ($1, $2, 'capability', $3, 'capability.run', $4::jsonb, 'pending', $5, $5)`,
      [
        id,
        SPACE,
        SKILL,
        JSON.stringify({
          verbId: "computer.run_recipe",
          skillId: SKILL,
          summary: "Run computer run recipe",
          parameters,
          workspaceId: SPACE,
          connectionSelector: null,
        }),
        AGENT,
      ]
    );
    return id;
  }

  async function approve(proposalId: string) {
    const { db, proposals, eq } = await import("@synap/database");
    const [proposal] = await (db as any)
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposalId));
    const { completeProposalApproval } =
      await import("../../routers/proposals/apply-approval.js");
    return completeProposalApproval(
      {
        proposal,
        userId: PERSON,
        input: { proposalId },
        ctx: { userId: PERSON, workspaceId: SPACE } as never,
      },
      null
    ).then(
      (result) => ({ result, error: null as Error | null }),
      (error: Error) => ({ result: null, error })
    );
  }

  const rowOf = async (id: string) =>
    (
      await q<{
        status: string;
        rejection_reason: string | null;
        data: { failure?: { errorClass?: string } };
        external_dispatched_at: string | null;
      }>(
        `SELECT status, rejection_reason, data, external_dispatched_at FROM proposals WHERE id = $1`,
        [id]
      )
    ).rows[0]!;

  it("a refusal is recorded as its own sentence and class, and the claim is released (Retry re-runs)", async () => {
    const id = await proposeRun({
      capability: "media-ffmpeg",
      recipe: "range-cut",
      params: { in: CLIP, out: "take-cut.mp4", start: "2", end: "7" },
      computer: "mac",
    });
    const { error } = await approve(id);
    expect(error?.message).toMatch(
      /approved version has no recipe "range-cut".*action "update"/
    );
    const row = await rowOf(id);
    expect(row.status).toBe("approval_failed");
    expect(row.rejection_reason).toMatch(
      /^Couldn't apply — media-ffmpeg on MacBook-Pro: its approved version has no recipe "range-cut"; ask for its update/
    );
    expect(row.rejection_reason).not.toMatch(/internal error/);
    expect(row.data.failure?.errorClass).toBe("target_missing");
    // Nothing ran, so nothing holds the claim: approving again really retries.
    expect(row.external_dispatched_at).toBeNull();
    expect((await q(`SELECT 1 FROM host_jobs`)).rows).toHaveLength(0);
  });

  it("an accepted run is approved and queued on the computer", async () => {
    const id = await proposeRun(ask({ computer: "mac" }));
    const { result, error } = await approve(id);
    expect(error).toBeNull();
    expect(result?.success).toBe(true);
    expect((await rowOf(id)).status).toBe("approved");
    const jobs = await q<{ kind: string; installation_id: string }>(
      `SELECT kind, installation_id FROM host_jobs`
    );
    expect(jobs.rows).toEqual([{ kind: "verb", installation_id: INST_MAC }]);
  });
});

describe("hosted verb runs on the computer", () => {
  it("a run waits while a lifecycle job of its tool is open, then carries its input as a link signed for the owner", async () => {
    const out = (await run(ask(), ctx)) as { hostJobId: string };
    // A check queued AFTER the run still goes first: the run waits for it.
    await q(
      `INSERT INTO host_jobs (kind, installation_id, user_id, machine_user_id, spec, status)
       VALUES ('verify', $1, $2, $3, '{}'::jsonb, 'queued')`,
      [INST_MAC, PERSON, MAC]
    );
    const first = await lease();
    expect(first?.kind).toBe("verify");
    expect(await lease()).toBeNull();
    await q(`UPDATE host_jobs SET status = 'done' WHERE kind = 'verify'`);

    const job = await lease();
    expect(job).toMatchObject({ id: out.hostJobId, kind: "verb" });
    expect(job!.inputs).toEqual({
      in: [
        expect.objectContaining({
          fileEntityId: CLIP,
          url: `https://s3.test/${CLIP}?sig=1`,
          name: "0-My-clip.mp4",
        }),
      ],
    });
    expect(h.signedFor).toEqual([
      { userId: PERSON, id: CLIP, ttl: 6 * 60 * 60 },
    ]);
  });

  it("a run whose tool is not installed is not leased", async () => {
    await run(ask(), ctx);
    await q(`UPDATE installations SET status = 'updating' WHERE id = $1`, [
      INST_MAC,
    ]);
    expect(await lease()).toBeNull();
  });

  it("a file no longer readable fails the run with the reason, never a lease", async () => {
    const out = (await run(ask(), ctx)) as { hostJobId: string };
    h.readable.delete(`${PERSON}:${CLIP}`);
    try {
      expect(await lease()).toBeNull();
    } finally {
      h.readable.add(`${PERSON}:${CLIP}`);
    }
    const r = await q<{ status: string; error: string }>(
      `SELECT status, error FROM host_jobs WHERE id = $1`,
      [out.hostJobId]
    );
    expect(r.rows[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("can no longer be read"),
    });
    expect(h.notices.at(-1)?.content).toContain("failed");
  });

  it("uploads are minted for the requester, only for a held verb job", async () => {
    await run(ask(), ctx);
    const job = (await lease())!;
    const res = await post(`/host-jobs/${job.id}/uploads`, {
      leaseId: job.leaseId,
      filename: "clip-loud.mp4",
      mimeType: "video/mp4",
      size: 4321,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      uploadToken: "tok-clip-loud.mp4",
    });
    expect(h.uploadAsks).toEqual([
      expect.objectContaining({
        userId: PERSON,
        agentUserId: AGENT,
        sessionId: SESSION,
        workspaceId: SPACE,
        filename: "clip-loud.mp4",
      }),
    ]);
    // A stale lease is refused.
    const stale = await post(`/host-jobs/${job.id}/uploads`, {
      leaseId: randomUUID(),
      filename: "x.mp4",
      mimeType: "video/mp4",
      size: 1,
    });
    expect(stale.status).toBe(409);
  });

  it("a lifecycle job returns no files", async () => {
    await q(
      `INSERT INTO host_jobs (kind, installation_id, user_id, machine_user_id, spec, status)
       VALUES ('verify', $1, $2, $3, '{}'::jsonb, 'queued')`,
      [INST_MAC, PERSON, MAC]
    );
    const job = (await lease())!;
    const res = await post(`/host-jobs/${job.id}/uploads`, {
      leaseId: job.leaseId,
      filename: "x.mp4",
      mimeType: "video/mp4",
      size: 1,
    });
    expect(res.status).toBe(400);
    expect(h.uploadAsks).toHaveLength(0);
  });

  it("the finish stores each output as the requester's file, names it, and the feed tells the truth", async () => {
    const out = (await run(ask(), ctx)) as { hostJobId: string };
    const queued = await listHostVerbRunsForFeed(PERSON, {}, 10);
    expect(queued).toEqual([
      expect.objectContaining({ id: out.hostJobId, status: "running" }),
    ]);
    const job = (await lease())!;
    const fin = await post(`/host-jobs/${job.id}/finish`, {
      leaseId: job.leaseId,
      status: "done",
      durationMs: 900,
      steps: [{ name: "python", ok: true }],
      files: [
        {
          param: "out",
          name: "clip-loud.mp4",
          size: 4321,
          uploadToken: "tok-1",
        },
        { param: "extra", name: "missing.mp4", error: "not written" },
      ],
    });
    expect(fin.status).toBe(200);
    const body = (await fin.json()) as { files: unknown[] };
    expect(body.files).toEqual([
      {
        param: "out",
        name: "clip-loud.mp4",
        status: "stored",
        fileEntityId: "file-tok-1",
        documentId: "doc-1",
      },
      {
        param: "extra",
        name: "missing.mp4",
        status: "missing",
        error: "not written",
      },
    ]);
    expect(h.finalized).toEqual([
      expect.objectContaining({
        userId: PERSON,
        agentUserId: AGENT,
        sessionId: SESSION,
        uploadToken: "tok-1",
        title: "clip-loud.mp4",
      }),
    ]);
    const ev = await q<{ evidence: { files: unknown[] }; status: string }>(
      `SELECT evidence, status FROM host_jobs WHERE id = $1`,
      [out.hostJobId]
    );
    expect(ev.rows[0]!.status).toBe("done");
    expect(ev.rows[0]!.evidence.files).toHaveLength(2);
    expect(h.notices.at(-1)).toEqual({
      sessionId: SESSION,
      content: expect.stringContaining("clip-loud.mp4 (file file-tok-1)"),
    });
    const done = await listHostVerbRunsForFeed(
      PERSON,
      { sessionId: SESSION },
      10
    );
    expect(done).toEqual([
      expect.objectContaining({
        id: out.hostJobId,
        status: "completed",
        summary: "Finished on MacBook-Pro · 1 file",
      }),
    ]);
  });
});

describe("discovery: the recipes installed on the person's computers", () => {
  // media-ffmpeg as Synap's catalog declares it: it provides edit_video
  // (capability-level `provides`, read through `declaredProvides`).
  beforeAll(async () => {
    const { officialCatalogUrl } =
      await import("@synap/jobs/workers/cp-catalog-sync.js");
    await q(
      `INSERT INTO cp_catalog_cache (source, kind, slug, name, definition)
       VALUES ($1, 'capability', 'media-ffmpeg', 'ffmpeg', $2::jsonb)`,
      [officialCatalogUrl(), JSON.stringify({ provides: ["edit_video"] })]
    );
  });

  const read = (
    query: string,
    intents = ["edit_video", "send_message"],
    userId = PERSON
  ) => installedRecipesFor({ userId, intents, query, limit: 5 });

  it("names '<recipe> on <computer>' under the intent its tool provides, with what to run", async () => {
    const r = await read("normalize the loudness of my clip");
    expect([...r.keys()]).toEqual(["edit_video"]);
    expect(r.get("edit_video")).toEqual({
      matches: [
        expect.objectContaining({
          label: "loudness-normalize on MacBook-Pro",
          capability: "media-ffmpeg",
          recipe: "loudness-normalize",
          computer: { id: MAC, name: "MacBook-Pro" },
          params: LOUDNORM.params,
          run: {
            verbId: "computer.run_recipe",
            parameters: {
              capability: "media-ffmpeg",
              recipe: "loudness-normalize",
              computer: "MacBook-Pro",
            },
          },
        }),
      ],
      // The devbox's ffmpeg failed its check: not offered, matched or not.
      unmatched: [],
    });
  });

  it("recipes the words did not hit are still named, per tool and computer", async () => {
    const r = await read("crop to vertical");
    expect(r.get("edit_video")).toEqual({
      matches: [],
      unmatched: [
        {
          capability: "media-ffmpeg",
          computer: "MacBook-Pro",
          recipes: ["loudness-normalize"],
        },
      ],
    });
  });

  it("nothing installed and checked, or another person's: no block, never an empty one", async () => {
    expect((await read("loudness", ["edit_video"], "someone-else")).size).toBe(
      0
    );
    await setInstallation(INST_MAC, { status: "failed", verifyOk: false });
    expect((await read("loudness")).size).toBe(0);
  });
});
