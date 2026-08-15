import { describe, it, expect } from "vitest";
import { embeddingDegradeReasons } from "./health.js";

/**
 * PINS the POD half of the embedding signal — the half the IS `/health` cannot
 * see from where it sits (pod→IS transport, the pgvector write, an unstaffed
 * `entity-embedding` queue). See `EmbeddingPipelineHealth` for why the pod is
 * the only honest reporter of it.
 *
 * The two failure modes these tests exist to prevent:
 *   • ALWAYS-RED — a lifetime failure count never decays (pg-boss keeps failed
 *     rows 7 days), so the signal must be windowed and must clear on its own.
 *   • ABSENCE-AS-HEALTH — an unreadable query previously produced no reason at
 *     all, so a broken job ledger read as a healthy one.
 */

const NOW = new Date("2026-08-16T02:00:00Z").getTime();
const HOUR = 3600_000;

function pipeline(
  over: Partial<Parameters<typeof embeddingDegradeReasons>[0]> = {}
) {
  return {
    readable: true,
    recentFailed: 0,
    recentCompleted: 0,
    windowMinutes: 15,
    ...over,
  };
}

describe("embeddingDegradeReasons", () => {
  it("reports failing when the pipeline fails at least as often as it succeeds", () => {
    expect(
      embeddingDegradeReasons(
        pipeline({ recentFailed: 4, recentCompleted: 0 }),
        new Date(NOW),
        NOW
      )
    ).toContain("embeddings:failing");
  });

  it("GREEN AGAIN: failures aging out of the window clear it, with no reset", () => {
    // Same pod one window later — the failed rows are still in pgboss.job for
    // 7 days, but they are no longer INSIDE the window, so the count is 0.
    expect(
      embeddingDegradeReasons(pipeline(), new Date(NOW), NOW)
    ).not.toContain("embeddings:failing");
  });

  it("GREEN AGAIN: succeeding more than it fails is retrying, not down", () => {
    expect(
      embeddingDegradeReasons(
        pipeline({ recentFailed: 1, recentCompleted: 40 }),
        new Date(NOW),
        NOW
      )
    ).not.toContain("embeddings:failing");
  });

  it("a quiet pipeline (0 failed, 0 completed) is not reported as failing", () => {
    expect(embeddingDegradeReasons(pipeline(), new Date(NOW), NOW)).toEqual([]);
  });

  it("an UNREADABLE ledger is reported, not swallowed into silence", () => {
    const reasons = embeddingDegradeReasons(
      pipeline({ readable: false }),
      new Date(NOW),
      NOW
    );
    expect(reasons).toContain("embeddings:unreadable");
    // …and it does not ALSO claim to know the failure count.
    expect(reasons).not.toContain("embeddings:failing");
  });

  it("still reports stale vector writes past 24h", () => {
    expect(
      embeddingDegradeReasons(pipeline(), new Date(NOW - 30 * HOUR), NOW)
    ).toContain("embeddings:stale");
  });

  it("never fabricates staleness from an unknown last-write time", () => {
    expect(embeddingDegradeReasons(pipeline(), null, NOW)).not.toContain(
      "embeddings:stale"
    );
  });
});
