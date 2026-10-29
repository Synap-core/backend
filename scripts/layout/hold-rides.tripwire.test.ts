/**
 * The "Dependencies merged" hold lets a dependent RIDE the merge queue with a
 * dependency of the same repo (founder, 2026-10-29, merge bot; Zuul's "test
 * together, land in order"). A wrong "rides" lets a PR land WITHOUT what it
 * depends on: the one thing the hold exists to stop. So this pins:
 *   - on the PR: a dependency counts only while it is IN the queue;
 *   - in the queue: only when the group's base..head MERGES the dependency's
 *     current head (a branch merely stacked on it does not count);
 *   - another repo's dependency, or a commit dependency, never rides;
 *   - a failed read never rides;
 * through hold.mjs main() with GitHub's wire shapes (fetch stubbed), so the
 * seam from the event to the posted check run is what is tested.
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 *
 * NOT covered: a real 2-entry merge group (none on record: every queue head
 * on 29 Oct was a 1-entry group). The 1-entry shape the rule reads was seen on
 * aa8f854fa ("Merge pull request #485", parents 409270a3d,dd3a7bb19).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain ESM script, no declarations
import * as H from "./hold.mjs";

const REPO = "Synap-core/backend";
const sha = (c: string) => c.repeat(40);
const waiting = (n: number, repo = REPO, kind = "pr") => ({
  dep: { kind, repo, number: n, label: `backend#${n}` },
  status: "waiting",
  testRef: null,
  detail: "open, into main",
});

describe("hold: on the PR, a dependency rides while it is in the queue", () => {
  const queued = new Map([[20, sha("2")]]);
  it("queued: counts, and the check posts success", () => {
    const r = H.rideTheQueue([waiting(20)], { repo: REPO, queued });
    expect(r[0]).toMatchObject({ status: "landed", rides: "queue" });
    expect(H.checkFor(r)).toMatchObject({ conclusion: "success" });
  });
  it.each([
    ["not queued", [waiting(21)]],
    [
      "another repo's PR with the same number",
      [waiting(20, "Synap-core/app-bases")],
    ],
    ["a commit dependency", [waiting(20, REPO, "ref")]],
  ])("waits: %s", (_n, results) => {
    const r = H.rideTheQueue(results, { repo: REPO, queued });
    expect(r[0].status).toBe("waiting");
    expect(H.checkFor(r).status).toBe("in_progress");
  });
  it("a blocked dependency stays blocked", () => {
    const r = H.rideTheQueue([{ ...waiting(20), status: "blocked" }], {
      repo: REPO,
      queued,
    });
    expect(r[0].status).toBe("blocked");
  });
});

describe("hold: in the queue, a dependency rides only when the group's own line merges its head", () => {
  const heads = new Map([[20, sha("2")]]);
  const D = sha("d"); // the dependent's head
  // The queue's line: base 0 -> a = merge of #20 (parents 0, 2) -> c = merge of D (parents a, D).
  const line = [
    { sha: sha("a"), parents: [{ sha: sha("0") }, { sha: sha("2") }] },
    { sha: sha("c"), parents: [{ sha: sha("a") }, { sha: D }] },
  ];
  const ride = (groupCommits: unknown[], headSha = sha("c")) =>
    H.rideInGroup([waiting(20)], {
      repo: REPO,
      heads,
      groupCommits,
      headSha,
    })[0];
  it("the group's first-parent line merges #20's current head: counts", () => {
    expect(ride(line)).toMatchObject({ status: "landed", rides: "group" });
  });
  it.each([
    [
      "the group does not hold #20 (it left the queue)",
      [{ sha: sha("c"), parents: [{ sha: sha("0") }, { sha: D }] }],
    ],
    [
      "the dependent's AUTHOR merged #20 into its own branch: reached through a second parent, not the group's line",
      [
        { sha: sha("c"), parents: [{ sha: sha("0") }, { sha: D }] },
        { sha: D, parents: [{ sha: sha("7") }, { sha: sha("2") }] },
      ],
    ],
    [
      "a branch stacked on #20: its head is IN the range but no queue merge of it",
      [
        { sha: sha("c"), parents: [{ sha: sha("0") }, { sha: D }] },
        { sha: D, parents: [{ sha: sha("2") }] },
        { sha: sha("2"), parents: [{ sha: sha("0") }] },
      ],
    ],
    [
      "the group merged an OLD head of #20 (#20 moved since)",
      [
        { sha: sha("a"), parents: [{ sha: sha("0") }, { sha: sha("1") }] },
        line[1],
      ],
    ],
    ["no commits read", []],
  ])("waits: %s", (_n, groupCommits) => {
    expect(ride(groupCommits).status).toBe("waiting");
  });
  it("a group head that is not in the range: waits (no line to read)", () => {
    expect(ride(line, sha("e")).status).toBe("waiting");
  });
  it("another repo's dependency never rides, even with a matching merge", () => {
    const r = H.rideInGroup([waiting(20, "Synap-core/app-bases")], {
      repo: REPO,
      heads,
      groupCommits: line,
      headSha: sha("c"),
    });
    expect(r[0].status).toBe("waiting");
  });
});

describe("hold: main's required checks, one parse", () => {
  it("reads the required_status_checks rules, and refuses what is not a list", () => {
    expect(
      H.requiredContextsOf([
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "Release gate" },
              { context: "Dependencies merged" },
            ],
          },
        },
      ])
    ).toEqual(["Release gate", "Dependencies merged"]);
    expect(() => H.requiredContextsOf({ message: "Not Found" })).toThrow();
  });
});

// ── hold.mjs main(), end to end, GitHub stubbed ─────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Route = (method: string, path: string, body: any) => unknown;
async function runHold(event: string, payload: unknown, route: Route) {
  const dir = mkdtempSync(join(tmpdir(), "hold-"));
  dirs.push(dir);
  writeFileSync(join(dir, "event.json"), JSON.stringify(payload));
  const posted: any[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace("https://api.github.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (method === "POST" && path.endsWith("/check-runs")) {
      posted.push(body);
      return {
        ok: true,
        status: 201,
        json: async () => ({}),
        text: async () => "",
      };
    }
    if (path.includes("/check-runs?check_name="))
      return {
        ok: true,
        status: 200,
        json: async () => ({ check_runs: [] }),
        text: async () => "",
      };
    const out = route(method, path, body);
    if (out === undefined)
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "not found",
      };
    return {
      ok: true,
      status: 200,
      json: async () => out,
      text: async () => "",
    };
  });
  const logs: string[] = [];
  const code = await H.main(
    {
      GITHUB_REPOSITORY: REPO,
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      GITHUB_TOKEN: "t",
    },
    (l: string) => logs.push(l)
  );
  return { code, posted, logs };
}

const PR20 = {
  state: "open",
  merged_at: null,
  base: { ref: "main" },
  mergeable: true,
  draft: false,
  head: { sha: sha("2") },
};
const BODY = "Needs the type first.\n\nDepends-On: backend#20\n";

describe("hold: main(), the posted check", () => {
  const mg = {
    head_ref: "gh-readonly-queue/main/pr-21-" + "c".repeat(40),
    base_sha: sha("0"),
    head_sha: sha("c"),
  };
  const groupRoute =
    (commits: unknown[]): Route =>
    (_m, path) => {
      if (path === `/repos/${REPO}/pulls/21`) return { body: BODY };
      if (path === `/repos/${REPO}/pulls/20`) return PR20;
      if (path === `/repos/${REPO}/compare/${sha("0")}...${sha("c")}`)
        return { commits };
      return undefined;
    };

  it("merge_group whose range merges #20's head: success", async () => {
    const { posted } = await runHold(
      "merge_group",
      { merge_group: mg },
      groupRoute([
        { sha: sha("a"), parents: [{ sha: sha("0") }, { sha: sha("2") }] },
        { sha: sha("c"), parents: [{ sha: sha("a") }, { sha: sha("3") }] },
      ])
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      name: "Dependencies merged",
      head_sha: sha("c"),
      status: "completed",
      conclusion: "success",
    });
  });

  it("merge_group WITHOUT #20 (it left the queue, the group was rebuilt): held", async () => {
    const { posted } = await runHold(
      "merge_group",
      { merge_group: mg },
      groupRoute([
        { sha: sha("c"), parents: [{ sha: sha("0") }, { sha: sha("3") }] },
      ])
    );
    expect(posted[0]).toMatchObject({ status: "in_progress" });
    expect(posted[0].conclusion).toBeUndefined();
  });

  it("merge_group whose range cannot be read: held, never landed", async () => {
    const { posted, logs } = await runHold(
      "merge_group",
      { merge_group: mg },
      (_m, path) =>
        path === `/repos/${REPO}/pulls/21`
          ? { body: BODY }
          : path === `/repos/${REPO}/pulls/20`
            ? PR20
            : undefined
    );
    expect(posted[0]).toMatchObject({ status: "in_progress" });
    expect(logs.join("\n")).toMatch(/could not read the group's commits/);
  });

  const prEvent = {
    pull_request: { number: 21, head: { sha: sha("3") }, body: BODY },
  };
  const REQUIRED_WITH_HOLD = [
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [
          { context: "Release gate" },
          { context: "Dependencies merged" },
        ],
      },
    },
  ];
  const REQUIRED_WITHOUT_HOLD = [
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "Release gate" }] },
    },
  ];
  const prRoute =
    (queue: unknown, rules: unknown = REQUIRED_WITH_HOLD): Route =>
    (method, path) => {
      if (method === "POST" && path === "/graphql") return queue;
      if (path === `/repos/${REPO}/pulls/20`) return PR20;
      if (path === `/repos/${REPO}/rules/branches/main`)
        return rules ?? undefined;
      return undefined;
    };
  const QUEUED = {
    data: {
      repository: {
        pullRequest: { isInMergeQueue: true, headRefOid: sha("2") },
      },
    },
  };
  it("on the PR, #20 queued but the hold NOT required (riding off): held, never 'landed'", async () => {
    const { posted } = await runHold(
      "pull_request_target",
      prEvent,
      prRoute(QUEUED, REQUIRED_WITHOUT_HOLD)
    );
    expect(posted[0]).toMatchObject({ status: "in_progress" });
  });
  it("on the PR, #20 queued, main's rules unreadable: held", async () => {
    const { posted, logs } = await runHold(
      "pull_request_target",
      prEvent,
      prRoute(QUEUED, null)
    );
    expect(posted[0]).toMatchObject({ status: "in_progress" });
    expect(logs.join("\n")).toMatch(/could not read main's required checks/);
  });
  it("on the PR, #20 in the queue: success (the dependent may queue behind it)", async () => {
    const { posted } = await runHold(
      "pull_request_target",
      prEvent,
      prRoute({
        data: {
          repository: {
            pullRequest: { isInMergeQueue: true, headRefOid: sha("2") },
          },
        },
      })
    );
    expect(posted[0]).toMatchObject({
      head_sha: sha("3"),
      conclusion: "success",
    });
  });
  it("on the PR, #20 NOT in the queue: held", async () => {
    const { posted } = await runHold(
      "pull_request_target",
      prEvent,
      prRoute({
        data: {
          repository: {
            pullRequest: { isInMergeQueue: false, headRefOid: sha("2") },
          },
        },
      })
    );
    expect(posted[0]).toMatchObject({ status: "in_progress" });
  });
  it("on the PR, the queue state unreadable: held", async () => {
    const { posted } = await runHold(
      "pull_request_target",
      prEvent,
      prRoute(undefined)
    );
    expect(posted[0]).toMatchObject({ status: "in_progress" });
  });
});
