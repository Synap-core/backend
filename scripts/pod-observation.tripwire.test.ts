/**
 * The GitHub producer (pod-observation.mjs) only sends what the pod's
 * `observations.append` door accepts, and stays silent where it must.
 *
 * The door's rules are READ from their source, never copied here: the
 * namespaces from @synap-core/types, the reserved phases and the type shape
 * from observations.ts, and every payload is parsed by the dev-loop contract
 * (packages/types/src/events/dev-loop.ts, which the door checks per item). A
 * type the door would refuse (`ci.completed`) or a payload it would refuse
 * (a null optional field, a url that is not the PR) fails this test instead
 * of a run on GitHub after merge.
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSERVATION_NAMESPACES } from "../packages/types/src/events/unified.ts";
import {
  DEV_LOOP_EVENT_TYPES,
  POD_SESSION_LINE_RE,
  REQUIRED_CHECK_NAMES,
  checkDevLoopPayload,
  podSessionIdFromBody,
} from "../packages/types/src/events/dev-loop.ts";
import {
  POD_SESSION_LINE_RE as SCRIPT_POD_SESSION_LINE_RE,
  REQUIRED_CHECK_NAMES as SCRIPT_REQUIRED_CHECK_NAMES,
  isKeyRefusal,
  observationFromEvent,
  podSessionFromBody,
  postObservation,
  requiredChecksVerdict,
} from "./pod-observation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "pod-observation.mjs");
const DOOR = readFileSync(
  join(here, "../packages/api/src/routers/hub-protocol/observations.ts"),
  "utf8"
);

const RESERVED_PHASES = [
  ...(/RESERVED_PHASES\s*=\s*\[([^\]]*)\]/.exec(DOOR)?.[1] ?? "").matchAll(
    /"([^"]+)"/g
  ),
].map((m) => m[1]!);
const TYPE_SHAPE = new RegExp(
  /const TYPE_SHAPE = \/(.+)\/;/.exec(DOOR)?.[1] ?? "^$"
);

const SID = "cb0df539-7346-4db4-bf7d-a42b2abed58c";
const repository = {
  full_name: "Synap-core/backend",
  default_branch: "main",
};
const pr = (over: Record<string, unknown> = {}) => ({
  number: 42,
  html_url: "https://github.com/Synap-core/backend/pull/42",
  title: "feat: x",
  body: `Does x.\n\nPod session: ${SID}\n`,
  merged: false,
  merge_commit_sha: "abc1234",
  created_at: "2026-10-26T10:00:00Z",
  updated_at: "2026-10-26T11:00:00Z",
  closed_at: "2026-10-26T12:00:00Z",
  merged_at: null,
  head: {
    ref: "feat/x",
    sha: "bead001",
    repo: { full_name: "Synap-core/backend" },
  },
  base: { ref: "main" },
  user: { login: "antoine" },
  ...over,
});
const run = (over: Record<string, unknown> = {}) => ({
  html_url: "https://github.com/Synap-core/backend/actions/runs/7",
  name: "CI",
  head_sha: "bead001",
  head_branch: "feat/x",
  event: "pull_request",
  conclusion: "success",
  created_at: "2026-10-26T12:10:00Z",
  run_started_at: "2026-10-26T12:11:00Z",
  run_attempt: 1,
  updated_at: "2026-10-26T12:30:00Z",
  head_repository: { full_name: "Synap-core/backend" },
  pull_requests: [{ number: 42 }],
  ...over,
});

/** One fixture per branch of the event → type map. */
const EVERY_REPORTED = [
  observationFromEvent("pull_request", {
    action: "opened",
    pull_request: pr(),
    repository,
  }),
  observationFromEvent("pull_request", {
    action: "reopened",
    pull_request: pr(),
    repository,
  }),
  observationFromEvent("pull_request", {
    action: "closed",
    pull_request: pr({ merged: true, merged_at: "2026-10-26T12:00:00Z" }),
    repository,
  }),
  observationFromEvent("pull_request", {
    action: "closed",
    pull_request: pr(),
    repository,
  }),
  observationFromEvent("workflow_run", {
    action: "completed",
    workflow_run: run(),
    repository,
  }),
  observationFromEvent("pull_request", {
    action: "enqueued",
    pull_request: pr(),
    repository,
  }),
  observationFromEvent("workflow_run", {
    action: "requested",
    workflow_run: run({ conclusion: null }),
    repository,
  }),
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pod-observation: what the door accepts", () => {
  it("reads the door's rules (non-vacuous)", () => {
    expect(OBSERVATION_NAMESPACES.length).toBeGreaterThan(0);
    expect(RESERVED_PHASES).toContain(".completed");
    expect(TYPE_SHAPE.source).not.toBe("^$");
  });

  it("every type it sends is in a registered namespace, ends in no reserved phase, and has the door's shape", () => {
    const types = EVERY_REPORTED.map((o) => o?.type);
    expect(types).toEqual([
      DEV_LOOP_EVENT_TYPES.prOpened,
      DEV_LOOP_EVENT_TYPES.prOpened,
      DEV_LOOP_EVENT_TYPES.prMerged,
      DEV_LOOP_EVENT_TYPES.prClosed,
      DEV_LOOP_EVENT_TYPES.ciFinished,
      DEV_LOOP_EVENT_TYPES.mergeQueued,
      DEV_LOOP_EVENT_TYPES.ciStarted,
    ]);
    for (const t of types as string[]) {
      expect(
        OBSERVATION_NAMESPACES.some((ns) => t.startsWith(`${ns}.`)),
        t
      ).toBe(true);
      expect(
        RESERVED_PHASES.some((p) => t.endsWith(p)),
        t
      ).toBe(false);
      expect(TYPE_SHAPE.test(t), t).toBe(true);
    }
  });
});

describe("pod-observation: the dev-loop contract", () => {
  it("every payload it sends parses with the contract the door checks", () => {
    const withSession = observationFromEvent(
      "workflow_run",
      { action: "completed", workflow_run: run(), repository },
      { sessionId: SID }
    );
    const noBody = observationFromEvent("pull_request", {
      action: "opened",
      pull_request: pr({ body: null, title: null }),
      repository,
    });
    for (const o of [...EVERY_REPORTED, withSession, noBody]) {
      expect(checkDevLoopPayload(o!.type, o!.data), o!.type).toEqual({
        contract: true,
        ok: true,
      });
    }
  });
});

describe("pod-observation: the facts it carries", () => {
  it("a merged PR carries its url, merge sha and the body's pod session", () => {
    const o = EVERY_REPORTED[2]!;
    expect(o.subjectId).toBe("Synap-core/backend#42");
    expect(o.occurredAt).toBe("2026-10-26T12:00:00Z");
    expect(o.data).toMatchObject({
      url: "https://github.com/Synap-core/backend/pull/42",
      repo: "Synap-core/backend",
      number: 42,
      merged: true,
      sha: "abc1234",
      headSha: "bead001",
      branch: "feat/x",
      base: "main",
      intoDefault: true,
      sessionId: SID,
    });
  });

  it("a fork's PR names no session: its body is not carried, so no Pod session line reaches the pod", () => {
    for (const head of [
      { ref: "feat/x", sha: "bead001", repo: { full_name: "someone/backend" } },
      // A deleted fork: GitHub sends no head repo. Unknown is not trusted.
      { ref: "feat/x", sha: "bead001", repo: null },
    ]) {
      for (const merged of [true, false]) {
        const o = observationFromEvent("pull_request", {
          action: "closed",
          pull_request: pr({
            head,
            merged,
            merged_at: merged ? "2026-10-26T12:00:00Z" : null,
          }),
          repository,
        });
        expect(o?.type).toBe(merged ? "dev.pr_merged" : "dev.pr_closed");
        expect(o?.data).not.toHaveProperty("sessionId");
        expect(o?.data).not.toHaveProperty("body");
        expect(checkDevLoopPayload(o!.type, o!.data)).toMatchObject({
          ok: true,
        });
      }
    }
  });

  it("a stacked PR merged into its parent branch is not into the default branch", () => {
    const merged = pr({
      merged: true,
      merged_at: "2026-10-26T12:00:00Z",
      base: { ref: "feat/parent" },
    });
    const o = observationFromEvent("pull_request", {
      action: "closed",
      pull_request: merged,
      repository,
    });
    expect(o?.data).toMatchObject({ base: "feat/parent", intoDefault: false });
    expect(checkDevLoopPayload(o!.type, o!.data)).toMatchObject({ ok: true });
    // No default branch in the payload: unknown, so absent (never guessed).
    const unknown = observationFromEvent("pull_request", {
      action: "closed",
      pull_request: merged,
      repository: { full_name: "Synap-core/backend" },
    });
    expect(unknown?.data).not.toHaveProperty("intoDefault");
  });

  it("a PR closed without merge carries its head sha", () => {
    expect(EVERY_REPORTED[3]!.data).toMatchObject({
      merged: false,
      sha: "bead001",
    });
  });

  it("a finished run names its PR, status and the session passed in", () => {
    const o = observationFromEvent(
      "workflow_run",
      { action: "completed", workflow_run: run(), repository },
      { sessionId: SID }
    );
    expect(o?.subjectId).toBe("Synap-core/backend@bead001");
    expect(o?.data).toMatchObject({
      status: "success",
      pr: 42,
      workflow: "CI",
      sessionId: SID,
    });
  });

  it("a PR entering the merge queue is dev.merge_queued, at its update", () => {
    const o = EVERY_REPORTED[5]!;
    expect(o.subjectId).toBe("Synap-core/backend#42");
    expect(o.occurredAt).toBe("2026-10-26T11:00:00Z");
    expect(o.data).toMatchObject({
      repo: "Synap-core/backend",
      number: 42,
      url: "https://github.com/Synap-core/backend/pull/42",
      action: "enqueued",
      sessionId: SID,
    });
  });

  it("a requested run is ci.started, named like its ci.finished (the pod pairs them by workflow)", () => {
    const o = observationFromEvent(
      "workflow_run",
      { action: "requested", workflow_run: run(), repository },
      { sessionId: SID }
    );
    expect(o?.subjectId).toBe("Synap-core/backend@bead001");
    expect(o?.occurredAt).toBe("2026-10-26T12:11:00Z");
    expect(o?.data).toMatchObject({
      sha: "bead001",
      pr: 42,
      workflow: EVERY_REPORTED[4]!.data.workflow,
      attempt: 1,
      sessionId: SID,
    });
    expect(o?.data).not.toHaveProperty("status");
    // An in_progress run is not a second start.
    expect(
      observationFromEvent("workflow_run", {
        action: "in_progress",
        workflow_run: run(),
        repository,
      })
    ).toBeNull();
  });

  it("folds GitHub's other conclusions into the contract's, and skips an unknown one", () => {
    const at = (conclusion: string) =>
      observationFromEvent("workflow_run", {
        action: "completed",
        workflow_run: run({ conclusion }),
        repository,
      });
    expect(at("startup_failure")?.data.status).toBe("failure");
    expect(at("something_new")).toBeNull();
  });

  it("reports nothing for other PR actions or a fork's run", () => {
    expect(
      observationFromEvent("pull_request", {
        action: "edited",
        pull_request: pr(),
        repository,
      })
    ).toBeNull();
    expect(
      observationFromEvent("workflow_run", {
        action: "completed",
        workflow_run: run({
          head_repository: { full_name: "someone/backend" },
        }),
        repository,
      })
    ).toBeNull();
  });

  it("reads the Pod session line with the ONE rule (dev-loop.ts POD_SESSION_LINE_RE)", () => {
    expect(SCRIPT_POD_SESSION_LINE_RE.source).toBe(POD_SESSION_LINE_RE.source);
    expect(SCRIPT_POD_SESSION_LINE_RE.flags).toBe(POD_SESSION_LINE_RE.flags);
    const samples: [string | null, string | null][] = [
      [`**Pod session:** ${SID.toUpperCase()}`, SID],
      [`- Pod session ${SID}`, SID],
      [`> pod session: ${SID}`, SID],
      [`Does x.\n\nPod session: \`${SID}\`\n`, SID],
      [`See the Pod session ${SID} for why.`, null],
      ["no line here", null],
      [null, null],
    ];
    for (const [body, want] of samples) {
      expect(podSessionFromBody(body), String(body)).toBe(want);
      expect(podSessionIdFromBody(body), String(body)).toBe(want);
    }
  });
});

describe("pod-observation: posting", () => {
  it("exits 0 and posts nothing when no pod is configured (forks)", () => {
    const env = { ...process.env };
    delete env.SYNAP_POD_URL;
    delete env.SYNAP_OBS_KEY;
    const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nothing posted");
  });

  it("a per-item refusal is an error, not a success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              result: {
                data: {
                  json: {
                    results: [{ ok: false, index: 0, error: "refused" }],
                  },
                },
              },
            }),
            { status: 200 }
          )
      )
    );
    expect(
      await postObservation("https://pod.example", "k", EVERY_REPORTED[0]!)
    ).toBe("refused");
  });

  it("an HTTP failure is an error; a recorded item is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 }))
    );
    expect(
      await postObservation("https://pod.example", "k", EVERY_REPORTED[0]!)
    ).toMatch(/^HTTP 401/);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              result: {
                data: { json: { results: [{ ok: true, index: 0, id: "e1" }] } },
              },
            }),
            { status: 200 }
          )
      )
    );
    expect(
      await postObservation("https://pod.example/", "k", EVERY_REPORTED[0]!)
    ).toBeNull();
  });

  /** Run the script on a PR event against a local pod that answers `reply`. */
  async function runAgainstPod(reply: { status: number; body: string }) {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(reply.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const eventPath = join(
      mkdtempSync(join(tmpdir(), "pod-obs-")),
      "event.json"
    );
    writeFileSync(
      eventPath,
      JSON.stringify({ action: "opened", pull_request: pr(), repository })
    );
    try {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          ...process.env,
          SYNAP_POD_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          SYNAP_OBS_KEY: "k",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_EVENT_PATH: eventPath,
        },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const code = await new Promise<number | null>((r) =>
        child.on("close", r)
      );
      return { code, out };
    } finally {
      server.close();
    }
  }
  const refusal = (error: string) =>
    JSON.stringify({
      result: { data: { json: { results: [{ ok: false, index: 0, error }] } } },
    });

  it("a refused KEY is a warning and exit 0, not a red check on every PR", async () => {
    for (const reply of [
      {
        status: 200,
        body: refusal('This key\'s grant does not allow "event.create".'),
      },
      { status: 401, body: "unauthorized" },
      { status: 403, body: "forbidden" },
    ]) {
      const r = await runAgainstPod(reply);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("::warning::the pod refused this repo's key");
      expect(r.out).not.toContain("::error::");
    }
  });

  it("any other refusal, or a pod error, still reds the run", async () => {
    for (const reply of [
      {
        status: 200,
        body: refusal("data does not match the dev.pr_opened contract"),
      },
      { status: 500, body: "boom" },
    ]) {
      const r = await runAgainstPod(reply);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("::error::the pod did not record");
    }
    expect(isKeyRefusal(null)).toBe(false);
  });
});

describe("pod-observations.yml: the debounce never drops a PR event or a main run", () => {
  // The concurrency group cancels a waiting post for a PR branch when a newer
  // CI run of that branch finishes (2026-10-29). A pull_request event
  // (dev.pr_merged …) or a main run sharing a group with anything would be
  // dropped the same way: each must fall to its own run's group. Text-level:
  // it pins the expression, it does not evaluate it.
  const wf = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../.github/workflows/pod-observations.yml"
    ),
    "utf8"
  );

  it("only a workflow_run of a non-main branch shares a group", () => {
    expect(wf).toContain(
      "  group: ${{ github.workflow }}-${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_branch != 'main' && format('ci-{0}', github.event.workflow_run.head_branch) || github.run_id }}\n"
    );
    expect(wf).toMatch(/^ {2}cancel-in-progress: true$/m);
  });
});

/**
 * Finding 1bff8284: "Checks finished ... passed" was read off one workflow's
 * conclusion. #584 (conflicting, so no CI; only Depends-On ran green) and #606
 * (CI finished while its Full suite still ran) both read "passed". The fact now
 * carries the verdict of the PR head's 4 required checks, and a run of a
 * workflow other than CI is not a fact at all.
 */
describe("ci.finished says whether the required checks are green", () => {
  const cr = (
    name: string,
    status: string,
    conclusion: string | null,
    id = 1
  ) => ({
    id,
    name,
    status,
    conclusion,
  });
  const allGreen = REQUIRED_CHECK_NAMES.map((n, i) =>
    cr(n, "completed", "success", i + 1)
  );

  it("the script's required names are the contract's", () => {
    expect([...SCRIPT_REQUIRED_CHECK_NAMES]).toEqual([...REQUIRED_CHECK_NAMES]);
  });

  it("all 4 green is green", () => {
    expect(
      requiredChecksVerdict({ checkRuns: allGreen, mergeableState: "clean" })
    ).toEqual({
      verdict: "green",
    });
  });

  it("#606 shape: CI finished but the Full suite still runs is pending", () => {
    const runs = allGreen.map((c) =>
      c.name === "Full suite" ? cr("Full suite", "in_progress", null, c.id) : c
    );
    expect(
      requiredChecksVerdict({ checkRuns: runs, mergeableState: "blocked" })
    ).toEqual({
      verdict: "pending",
      pending: ["Full suite"],
    });
  });

  it("a required check that never reported (others did) is pending, not green", () => {
    const runs = allGreen.filter((c) => c.name !== "API e2e");
    expect(requiredChecksVerdict({ checkRuns: runs }).verdict).toBe("pending");
  });

  it("a failed required check is red, with its name", () => {
    const runs = allGreen.map((c) =>
      c.name === "API e2e" ? cr("API e2e", "completed", "failure", c.id) : c
    );
    expect(requiredChecksVerdict({ checkRuns: runs })).toEqual({
      verdict: "red",
      failing: ["API e2e"],
    });
  });

  it("a rerun's newest check run wins", () => {
    const runs = [...allGreen, cr("Full suite", "completed", "failure", 0)];
    expect(requiredChecksVerdict({ checkRuns: runs }).verdict).toBe("green");
  });

  it("#608 shape: a draft with Release gate pending and Reference docs red, beside green small workflows, is red, never green", () => {
    const runs = [
      cr("Release gate", "in_progress", null, 1),
      cr("Reference docs are current", "completed", "failure", 2),
      cr("Full suite", "completed", "failure", 3),
      cr("API e2e", "completed", "failure", 4),
      cr("Preflight", "completed", "success", 5),
      cr("What changed", "completed", "success", 6),
      cr("Dependencies merged", "completed", "success", 7),
      cr("Depends-On hold", "completed", "success", 8),
      cr("Post to the pod", "completed", "success", 9),
    ];
    const v = requiredChecksVerdict({
      checkRuns: runs,
      mergeableState: "blocked",
    });
    expect(v.verdict).toBe("red");
    expect(v.failing).toContain("Reference docs are current");
  });

  it("#584 shape: a conflicting PR is no_ci, even with a green run on the branch", () => {
    expect(
      requiredChecksVerdict({ checkRuns: allGreen, mergeableState: "dirty" })
    ).toEqual({ verdict: "no_ci" });
  });

  it("#584 shape: only non-required checks on the head is no_ci", () => {
    expect(
      requiredChecksVerdict({
        checkRuns: [cr("Depends-On hold", "completed", "success")],
        mergeableState: "unknown",
      })
    ).toEqual({ verdict: "no_ci" });
  });

  it("#584 shape: a Depends-On run finishing green is never a fact", () => {
    expect(
      observationFromEvent("workflow_run", {
        action: "completed",
        workflow_run: run({ name: "Depends-On", event: "pull_request_target" }),
        repository,
      })
    ).toBeNull();
    expect(
      observationFromEvent("workflow_run", {
        action: "requested",
        workflow_run: run({ name: "Merge bot", conclusion: null }),
        repository,
      })
    ).toBeNull();
  });

  it("a CI run carries the verdict it was given, and the contract accepts it", () => {
    const o = observationFromEvent(
      "workflow_run",
      { action: "completed", workflow_run: run(), repository },
      { requiredChecks: { verdict: "pending", pending: ["Full suite"] } }
    )!;
    expect(o.data.requiredChecks).toEqual({
      verdict: "pending",
      pending: ["Full suite"],
    });
    expect(checkDevLoopPayload("ci.finished", o.data).ok).toBe(true);
  });
});
