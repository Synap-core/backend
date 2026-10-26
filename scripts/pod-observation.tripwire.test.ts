/**
 * The GitHub producer (pod-observation.mjs) only sends what the pod's
 * `observations.append` door accepts, and stays silent where it must.
 *
 * The door's rules are READ from their source (the namespaces from
 * @synap-core/types, the reserved phases and the type shape from
 * observations.ts), never copied here: a type the door would refuse, such as
 * `ci.completed`, fails this test instead of a run on GitHub after merge.
 * Named `*.tripwire.test.ts` so `pnpm tripwires` (CI) runs it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSERVATION_NAMESPACES } from "../packages/types/src/events/unified.ts";
import {
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
  ...(/RESERVED_PHASES\s*=\s*\[([^\]]*)\]/.exec(DOOR)?.[1] ?? "").matchAll(/"([^"]+)"/g),
].map((m) => m[1]!);
const TYPE_SHAPE = new RegExp(/const TYPE_SHAPE = \/(.+)\/;/.exec(DOOR)?.[1] ?? "^$");

const SID = "cb0df539-7346-4db4-bf7d-a42b2abed58c";
const repository = { full_name: "Synap-core/backend" };
const pr = (over: Record<string, unknown> = {}) => ({
  number: 42,
  html_url: "https://github.com/Synap-core/backend/pull/42",
  title: "feat: x",
  body: `Does x.\n\nPod session: ${SID}\n`,
  merged: false,
  merge_commit_sha: "abc123",
  created_at: "2026-10-26T10:00:00Z",
  updated_at: "2026-10-26T11:00:00Z",
  closed_at: "2026-10-26T12:00:00Z",
  merged_at: null,
  head: { ref: "feat/x", sha: "h1" },
  base: { ref: "main" },
  user: { login: "antoine" },
  ...over,
});
const run = (over: Record<string, unknown> = {}) => ({
  html_url: "https://github.com/Synap-core/backend/actions/runs/7",
  name: "CI",
  head_sha: "h1",
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
  observationFromEvent("pull_request", { action: "opened", pull_request: pr(), repository }),
  observationFromEvent("pull_request", { action: "reopened", pull_request: pr(), repository }),
  observationFromEvent("pull_request", {
    action: "closed",
    pull_request: pr({ merged: true, merged_at: "2026-10-26T12:00:00Z" }),
    repository,
  }),
  observationFromEvent("pull_request", { action: "closed", pull_request: pr(), repository }),
  observationFromEvent("workflow_run", { action: "completed", workflow_run: run(), repository }),
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
      "dev.pr_opened",
      "dev.pr_opened",
      "dev.pr_merged",
      "dev.pr_closed",
      "ci.run_finished",
    ]);
    for (const t of types as string[]) {
      expect(OBSERVATION_NAMESPACES.some((ns) => t.startsWith(`${ns}.`)), t).toBe(true);
      expect(RESERVED_PHASES.some((p) => t.endsWith(p)), t).toBe(false);
      expect(TYPE_SHAPE.test(t), t).toBe(true);
    }
  });
});

describe("pod-observation: the facts it carries", () => {
  it("a merged PR carries its url, merge sha and the body's pod session", () => {
    const o = EVERY_REPORTED[2]!;
    expect(o.subjectId).toBe("https://github.com/Synap-core/backend/pull/42");
    expect(o.occurredAt).toBe("2026-10-26T12:00:00Z");
    expect(o.data).toMatchObject({
      url: "https://github.com/Synap-core/backend/pull/42",
      repo: "Synap-core/backend",
      number: 42,
      merged: true,
      mergeSha: "abc123",
      headSha: "h1",
      podSession: SID,
    });
  });

  it("a PR closed without merge has no merge sha", () => {
    expect(EVERY_REPORTED[3]!.data).toMatchObject({ merged: false, mergeSha: null });
  });

  it("a finished run names its PRs and the session passed in", () => {
    const o = observationFromEvent(
      "workflow_run",
      { action: "completed", workflow_run: run(), repository },
      { podSession: SID }
    );
    expect(o?.data).toMatchObject({
      conclusion: "success",
      prUrls: ["https://github.com/Synap-core/backend/pull/42"],
      podSession: SID,
    });
  });

  it("reports nothing for other PR actions or a fork's run", () => {
    expect(
      observationFromEvent("pull_request", { action: "edited", pull_request: pr(), repository })
    ).toBeNull();
    expect(
      observationFromEvent("workflow_run", {
        action: "completed",
        workflow_run: run({ head_repository: { full_name: "someone/backend" } }),
        repository,
      })
    ).toBeNull();
  });

  it("reads the Pod session line the way the Work Map does", () => {
    expect(podSessionFromBody(`**Pod session:** ${SID.toUpperCase()}`)).toBe(SID);
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
              result: { data: { json: { results: [{ ok: false, index: 0, error: "refused" }] } } },
            }),
            { status: 200 }
          )
      )
    );
    expect(await postObservation("https://pod.example", "k", EVERY_REPORTED[0]!)).toBe("refused");
  });

  it("an HTTP failure is an error; a recorded item is null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    expect(await postObservation("https://pod.example", "k", EVERY_REPORTED[0]!)).toMatch(
      /^HTTP 401/
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ result: { data: { json: { results: [{ ok: true, index: 0, id: "e1" }] } } } }),
            { status: 200 }
          )
      )
    );
    expect(await postObservation("https://pod.example/", "k", EVERY_REPORTED[0]!)).toBeNull();
  });
});
