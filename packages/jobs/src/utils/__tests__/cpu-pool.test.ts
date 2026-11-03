/**
 * The CPU pool (cpu-pool.ts): what runs in its worker threads is EXACTLY what
 * runs inline (parity over real-looking documents: embeds, props blocks,
 * legacy props, columns, an unterminated embed, sections), and a task past
 * its deadline is a typed failure while the event loop keeps running.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  CPU_INLINE_MAX_CHARS,
  CPU_INLINE_MAX_EDGES,
  CpuTaskError,
  cpuTaskDeadlineMs,
  diagnoseMarkdownOffLoop,
  pageRankDeadlineMs,
  passagesOffLoop,
  rankGraph,
  segmentPassagesInWorker,
  shutdownCpuPool,
} from "../cpu-pool.js";
import {
  diagnoseTask,
  pagerankTask,
  passagesTask,
  segmentTask,
} from "../cpu-tasks.js";

afterAll(async () => {
  await shutdownCpuPool();
});

const E1 = "3f1c2a9e-0b7d-4c5e-9a10-1b2c3d4e5f60";
const E2 = "7d8e9f00-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const prose =
  "The quarterly review covers **pipeline health**, the [onboarding flow](https://example.com/onboarding) and `queue depth`. Each owner writes one paragraph; the summary closes the page.\n\n";

/** Documents of the kinds the pod stores, each well past the inline size. */
const SAMPLES: Record<string, string> = {
  "a report with embeds, props and a chart finding": [
    "# Q3 review",
    "",
    prose.repeat(3),
    "## Pipeline",
    "",
    `:::synap-entity{id="${E1}"}`,
    "The pipeline owner.",
    ":::",
    "",
    ':::synap-cell{cellKey="chart-pie"}',
    "```json",
    '{"profileSlug":"task","groupBy":"status","label":"Tasks by status"}',
    "```",
    "",
    "Most tasks are done.",
    ":::",
    "",
    "## Views",
    "",
    ':::synap-view{viewId="not-a-uuid"}',
    ":::",
    "",
    prose.repeat(4),
  ].join("\n"),
  "legacy props, a bad props block, an unknown directive, an unterminated embed":
    [
      "# Messy notes",
      "",
      prose.repeat(3),
      `:::synap-cell{cellKey="chart-bar" cellProps='{"profileSlug":"task"}'}`,
      ":::",
      "",
      ':::synap-cell{cellKey="list"}',
      "```json",
      "[1, 2, 3]",
      "```",
      ":::",
      "",
      ":::synap-unknown{x=1}",
      ":::",
      "",
      prose.repeat(2),
      `:::synap-entity{id="${E2}"}`,
      "Never closed, runs to the end.",
      "",
      prose.repeat(2),
    ].join("\n"),
  "columns, sections and a tone": [
    "# Plan",
    "",
    '::::synap-section{id="s1" owner="ai"}',
    "## Goals",
    "",
    prose.repeat(2),
    "::::",
    "",
    ":::::synap-columns",
    '::::synap-column{width="40%"}',
    "Left: :color[risk]{tone=danger} and ==notes=={tone=nope}.",
    "::::",
    '::::synap-column{width="70%"}',
    "Right column.",
    "::::",
    ":::::",
    "",
    "## Empty heading",
    "",
    "## Next",
    "",
    prose.repeat(5),
  ].join("\n"),
};

describe("CPU pool — results are the inline results, byte for byte", () => {
  for (const [name, md] of Object.entries(SAMPLES)) {
    it(`${name}: diagnose, passages, segment`, async () => {
      // Past the inline size: these ran in a worker.
      expect(md.length).toBeGreaterThan(CPU_INLINE_MAX_CHARS);
      const pairs: Array<[unknown, unknown]> = [
        [await diagnoseMarkdownOffLoop(md), diagnoseTask(md)],
        [await passagesOffLoop(md), passagesTask(md)],
        [await segmentPassagesInWorker(md), segmentTask(md)],
      ];
      for (const [pooled, inline] of pairs) {
        expect(pooled).toStrictEqual(inline);
        expect(JSON.stringify(pooled)).toBe(JSON.stringify(inline));
      }
    });
  }

  it("the samples are not trivial: they carry diagnostics, embeds and passages", () => {
    const all = Object.values(SAMPLES).map(diagnoseTask);
    expect(all.flatMap((r) => r.diagnostics).length).toBeGreaterThan(3);
    expect(all.flatMap((r) => r.embeds).length).toBeGreaterThan(4);
    expect(Object.values(SAMPLES).flatMap(passagesTask).length).toBeGreaterThan(
      3
    );
  });

  it("PageRank over a graph past the inline size: same scores, same order", async () => {
    const edges = Array.from(
      { length: CPU_INLINE_MAX_EDGES + 500 },
      (_, i) => ({
        src: `n${(i * 7) % 900}`,
        tgt: `n${(i * 13 + 5) % 900}`,
      })
    );
    const pooled = await rankGraph(edges);
    expect([...pooled]).toStrictEqual(pagerankTask(edges));
    expect(pooled.size).toBeGreaterThan(100);
  });
});

describe("CPU pool — a task past its deadline", () => {
  /** Seconds of parse: thousands of embeds, sections and lists. */
  const huge = (() => {
    let s = "# Huge\n\n";
    while (s.length < 600_000)
      s += `## Part\n\n${prose}:::synap-entity{id="${E1}"}\nFallback.\n:::\n\n- a\n- b\n\n`;
    return s;
  })();

  it("throws a typed CpuTaskError at the deadline, while the event loop keeps running", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const t0 = performance.now();
    const err = await diagnoseMarkdownOffLoop(huge, { deadlineMs: 300 }).then(
      () => null,
      (e: unknown) => e
    );
    const elapsed = performance.now() - t0;
    clearInterval(timer);
    expect(err).toBeInstanceOf(CpuTaskError);
    const e = err as CpuTaskError;
    expect(e.failure).toBe("timeout");
    expect(e.task).toBe("diagnose");
    expect(e.transient).toBe(false);
    expect(e.message).toBe(
      "the markdown parse for diagnostics ran past its deadline and was stopped (300 ms deadline)"
    );
    expect(elapsed).toBeLessThan(3_000);
    // The timer fired all along: the parse never held this thread.
    expect(ticks).toBeGreaterThanOrEqual(10);
  });

  it("the pool reads the next document normally after a timeout", async () => {
    const md = Object.values(SAMPLES)[0]!;
    expect(await diagnoseMarkdownOffLoop(md)).toStrictEqual(diagnoseTask(md));
  });
});

describe("CPU pool — knobs", () => {
  it("deadlines default to 10 s (markdown) and 60 s (PageRank), read from the environment", () => {
    expect(cpuTaskDeadlineMs({})).toBe(10_000);
    expect(cpuTaskDeadlineMs({ SYNAP_CPU_TASK_DEADLINE_MS: "2500" })).toBe(
      2_500
    );
    expect(cpuTaskDeadlineMs({ SYNAP_CPU_TASK_DEADLINE_MS: "5" })).toBe(10_000);
    expect(pageRankDeadlineMs({})).toBe(60_000);
  });

  it("a busy or crashed pool is transient; a timeout or memory cap is the input's", () => {
    expect(new CpuTaskError("passages", "busy", "x").transient).toBe(true);
    expect(new CpuTaskError("passages", "crashed", "x").transient).toBe(true);
    expect(new CpuTaskError("passages", "timeout", "x").transient).toBe(false);
    expect(new CpuTaskError("passages", "out_of_memory", "x").transient).toBe(
      false
    );
  });
});
