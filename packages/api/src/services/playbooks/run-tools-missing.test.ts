/**
 * A run on the pod's AI whose tools lack what a step declares never starts
 * (founder, 10 Nov 2026). Pure rules over an injected registry read; the doors
 * that call it are driven for real in
 * `routers/playbooks.run-tools-missing.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  findRunToolsMissing,
  refuseRunMissingTools,
  runToolsSaveWarnings,
  type RunToolsPlaybook,
} from "./run-tools-missing.js";

const registry = {
  index: new Map([
    ["search_web", [{ verbId: "web.search", verbKind: "read" }]],
    ["send_message", []],
  ]) as never,
  capabilities: [
    { id: "cap-gh", name: "github", verbs: [{ id: "github.pr_checks" }] },
  ],
};
const deps = { readRegistry: async () => registry };
const failing = {
  readRegistry: async () => {
    throw new Error("registry down");
  },
};
const lens = { workspaceId: "ws", userId: "u" };

function playbook(
  tools: string[],
  stageTools: string[],
  extra: Partial<RunToolsPlaybook> = {},
  stageExtra: Record<string, unknown> = {}
): RunToolsPlaybook {
  return {
    name: "Read the runs",
    executor: "is-agent",
    tools,
    stages: [
      { key: "read", name: "Read the runs", tools: stageTools, ...stageExtra },
      { key: "done", name: "Done" },
    ],
    ...extra,
  };
}

describe("findRunToolsMissing", () => {
  it("names each step and the tools nothing serves", async () => {
    const r = await findRunToolsMissing(
      {
        playbook: playbook(
          ["fireflies", "send_message", "get_session"],
          ["fireflies", "send_message", "get_session"]
        ),
        ...lens,
      },
      deps
    );
    expect(r).toEqual({
      status: "ok",
      missing: [
        {
          stageKey: "read",
          stageName: "Read the runs",
          missing: ["fireflies", "send_message"],
        },
      ],
    });
  });

  it("finds nothing missing when each entry is a run tool, a served intent or a visible capability", async () => {
    const r = await findRunToolsMissing(
      {
        playbook: playbook(
          ["get_session", "search_web", "github", "github.pr_checks"],
          ["get_session", "search_web", "github", "github.pr_checks"]
        ),
        ...lens,
      },
      deps
    );
    expect(r).toEqual({ status: "ok", missing: [] });
  });

  it("a step entry its playbook does not list is missing (never offered at run time)", async () => {
    const r = await findRunToolsMissing(
      { playbook: playbook(["web_fetch"], ["get_session"]), ...lens },
      deps
    );
    expect(r.status === "ok" && r.missing[0]?.missing).toEqual(["get_session"]);
  });

  it("a one-shot run has no tools: every step entry is missing", async () => {
    const r = await findRunToolsMissing(
      {
        playbook: playbook(["get_session"], ["get_session"], {
          executor: "generate",
        }),
        ...lens,
      },
      deps
    );
    expect(r.status === "ok" && r.missing[0]?.missing).toEqual(["get_session"]);
  });

  it("a step another agent runs is not checked", async () => {
    const r = await findRunToolsMissing(
      {
        playbook: playbook(
          ["fireflies"],
          ["fireflies"],
          {},
          {
            runner: { engine: "claude-code" },
          }
        ),
        ...lens,
      },
      deps
    );
    expect(r).toEqual({ status: "ok", missing: [] });
  });

  it("a failed registry read is unread, not missing", async () => {
    const r = await findRunToolsMissing(
      { playbook: playbook(["fireflies"], ["fireflies"]), ...lens },
      failing
    );
    expect(r).toEqual({ status: "unread" });
  });

  it("reads a run tool's MCP spelling as the run tool (synap_list_playbooks)", async () => {
    const r = await findRunToolsMissing(
      {
        playbook: playbook(
          ["synap_list_playbooks", "synap_get_session"],
          ["synap_list_playbooks", "get_session"]
        ),
        ...lens,
      },
      failing
    );
    expect(r).toEqual({ status: "ok", missing: [] });
  });

  it("a step without its own list declares the playbook's run tools only (D4)", async () => {
    const oneShot = {
      name: "Caption",
      executor: "generate",
      tools: ["web_search", "fireflies"],
      stages: [
        { key: "write", name: "Write" },
        { key: "own", name: "Own", tools: [] },
      ],
    };
    const r = await findRunToolsMissing({ playbook: oneShot, ...lens }, deps);
    expect(r).toEqual({
      status: "ok",
      missing: [
        { stageKey: "write", stageName: "Write", missing: ["web_search"] },
      ],
    });
    expect(
      await findRunToolsMissing(
        { playbook: { ...oneShot, executor: "is-agent" }, ...lens },
        failing
      )
    ).toEqual({ status: "ok", missing: [] });
  });
});

describe("refuseRunMissingTools", () => {
  it("lets a run of an external agent start (it brings its own tools)", async () => {
    await expect(
      refuseRunMissingTools(
        {
          playbook: playbook(["fireflies"], ["fireflies"]),
          ...lens,
          handedToAgent: false,
          executor: "external-agent",
        },
        deps
      )
    ).resolves.toBeUndefined();
  });
});

describe("runToolsSaveWarnings", () => {
  it("warns (never refuses) about a step whose tools a run here cannot use", async () => {
    const w = await runToolsSaveWarnings(
      { playbook: playbook(["fireflies"], ["fireflies"]), ...lens },
      deps
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /cannot start: its step "Read the runs" needs fireflies/
    );
  });

  it("is empty when every step tool resolves", async () => {
    expect(
      await runToolsSaveWarnings(
        { playbook: playbook(["get_session"], ["get_session"]), ...lens },
        deps
      )
    ).toEqual([]);
  });

  it("says the check could not run when the registry cannot be read", async () => {
    const w = await runToolsSaveWarnings(
      { playbook: playbook(["fireflies"], ["fireflies"]), ...lens },
      failing
    );
    expect(w[0]).toMatch(/could not be checked/);
  });
});
