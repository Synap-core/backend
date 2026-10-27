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
  checkDevLoopPayload,
} from "../packages/types/src/events/dev-loop.ts";
import {
  isKeyRefusal,
  observationFromEvent,
  podSessionFromBody,
  postObservation,
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
const repository = { full_name: "Synap-core/backend" };
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
  head: { ref: "feat/x", sha: "bead001" },
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
      sessionId: SID,
    });
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

  it("reads the Pod session line the way the Work Map does", () => {
    expect(podSessionFromBody(`**Pod session:** ${SID.toUpperCase()}`)).toBe(
      SID
    );
    expect(podSessionFromBody(`- Pod session ${SID}`)).toBe(SID);
    expect(podSessionFromBody("no line here")).toBeNull();
    expect(podSessionFromBody(null)).toBeNull();
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
