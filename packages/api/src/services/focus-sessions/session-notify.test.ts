/**
 * The devbox jobs a session read carries (`session-notify.ts`), folded from
 * the `ci.finished` rows as the devbox posts them (shape copied from a real
 * row of 1 Nov 2026: `workflow: "devbox <name>"`, `gates: [{id, status}]`,
 * `summaryPath` on the devbox, no url). Pure: the SQL that selects the rows is
 * THE dev-fact rule (`sessionDevFactWhere`), pinned by the change feed's and
 * the timeline's own tests.
 */
import { describe, it, expect } from "vitest";
import { foldDevboxJobs } from "./session-notify.js";

const run = (
  workflow: string,
  status: string,
  at: string,
  more: Record<string, unknown> = {}
) => ({
  at,
  data: {
    sha: "f38508a1",
    repo: "Synap-core/browser",
    status,
    workflow,
    source: "devbox-gate",
    summaryPath: "/home/x/wt/lane/runs/1.txt",
    gates: [
      { id: "browser-file", status: "green" },
      { id: "browser-tsc", status: "red" },
    ],
    ...more,
  },
});

describe("foldDevboxJobs", () => {
  it("one item per job, its NEWEST run, newest first, with its gates and verdict", () => {
    const items = foldDevboxJobs([
      run("devbox lane-a", "failure", "2026-11-01T18:42:00.000Z"),
      run("devbox lane-b", "success", "2026-11-01T18:30:00.000Z", {
        gates: undefined,
      }),
      run("devbox lane-a", "success", "2026-11-01T18:00:00.000Z"),
    ]);
    expect(items).toEqual([
      {
        job: "lane-a",
        repo: "Synap-core/browser",
        sha: "f38508a1",
        status: "failure",
        verdict: "failed",
        gates: [
          { id: "browser-file", status: "green" },
          { id: "browser-tsc", status: "red" },
        ],
        // The devbox posts a path on its own disk, never a url: no door.
        url: null,
        at: "2026-11-01T18:42:00.000Z",
        runs: 2,
      },
      {
        job: "lane-b",
        repo: "Synap-core/browser",
        sha: "f38508a1",
        status: "success",
        verdict: "passed",
        gates: [],
        url: null,
        at: "2026-11-01T18:30:00.000Z",
        runs: 1,
      },
    ]);
  });

  it("a CI workflow is not a devbox job; a cancelled run settles nothing; an http url is kept", () => {
    const items = foldDevboxJobs([
      run("CI", "success", "2026-11-01T18:50:00.000Z"),
      run("devbox lane-c", "cancelled", "2026-11-01T18:40:00.000Z", {
        url: "https://devbox.example/run/1",
      }),
      run("devbox lane-d", "success", "2026-11-01T18:39:00.000Z", {
        url: "javascript:alert(1)",
        repo: undefined,
      }),
    ]);
    expect(items.map((i) => [i.job, i.verdict, i.url])).toEqual([
      ["lane-c", null, "https://devbox.example/run/1"],
    ]);
  });

  it("drops a malformed gate and keeps at most 30", () => {
    const gates = [
      { id: "ok", status: "green" },
      { id: "", status: "green" },
      "nope",
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `g${i}`,
        status: "green",
      })),
    ];
    const [item] = foldDevboxJobs([
      run("devbox lane-e", "success", "2026-11-01T18:00:00.000Z", { gates }),
    ]);
    expect(item!.gates[0]).toEqual({ id: "ok", status: "green" });
    expect(item!.gates).toHaveLength(30);
  });
});
