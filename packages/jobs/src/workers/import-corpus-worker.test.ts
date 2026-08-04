/**
 * import-corpus worker — the job must RETURN its handler's result.
 *
 * pg-boss persists whatever the work callback resolves to as the job's `output`
 * column (`manager.js` → `complete(name, ids, result)`), and
 * `GET /import/corpus-job/:jobId` reads that column back. The worker used to
 * `await handler(job.data)` and discard the value, so a corpus run that
 * structured 1 of 3 files and recorded `filesFailed: 2` on its proposal polled
 * as an indistinguishably clean "completed" — silent data loss at 315 files.
 *
 * DB-free and network-free: the handler slot is the seam, so a stub fills it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type PgBoss from "pg-boss";
import {
  handleImportCorpus,
  registerImportCorpusHandler,
  type ImportCorpusPayload,
  type ImportCorpusResult,
} from "./import-corpus-worker.js";

function makeJob(): PgBoss.Job<ImportCorpusPayload> {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "import-corpus",
    expireInSeconds: 900,
    data: {
      userId: "user-1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      source: "markdown",
      items: [
        { path: "a.md", content: "one" },
        { path: "b.md", content: "two" },
        { path: "c.md", content: "three" },
      ],
    },
  } as PgBoss.Job<ImportCorpusPayload>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleImportCorpus", () => {
  it("returns the handler's result so pg-boss stores it as job output", async () => {
    const result: ImportCorpusResult = {
      proposalId: "prop-1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
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
    registerImportCorpusHandler(async () => result);

    const out = await handleImportCorpus(makeJob());

    // The load-bearing assertion — the exact value that was being dropped.
    expect(out).toEqual(result);
    expect(out?.filesFailed).toBe(2);
  });

  it("normalizes a handler that reports nothing to null (unknown, not success)", async () => {
    registerImportCorpusHandler(async () => undefined);

    const out = await handleImportCorpus(makeJob());

    expect(out).toBeNull();
  });

  it("passes the job payload through to the handler unchanged", async () => {
    const spy = vi.fn(async () => ({ proposalId: null, workspaceId: null }));
    registerImportCorpusHandler(spy);

    const job = makeJob();
    await handleImportCorpus(job);

    expect(spy).toHaveBeenCalledWith(job.data);
  });

  it("rethrows so pg-boss fails the job rather than completing it with no output", async () => {
    registerImportCorpusHandler(async () => {
      throw new Error("orchestrator exploded");
    });

    await expect(handleImportCorpus(makeJob())).rejects.toThrow(
      "orchestrator exploded"
    );
  });
});
