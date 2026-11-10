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
  RUN_TOOLS_MISSING,
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
          ["list_playbooks", "send_message", "get_session"],
          ["list_playbooks", "send_message", "get_session"]
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
          missing: ["list_playbooks", "send_message"],
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
          ["list_playbooks"],
          ["list_playbooks"],
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
      { playbook: playbook(["list_playbooks"], ["list_playbooks"]), ...lens },
      failing
    );
    expect(r).toEqual({ status: "unread" });
  });
});

describe("refuseRunMissingTools", () => {
  const lacking = playbook(["list_playbooks"], ["list_playbooks"]);

  it("refuses with RUN_TOOLS_MISSING, naming the step and the tool", async () => {
    const err = await refuseRunMissingTools(
      {
        playbook: lacking,
        ...lens,
        handedToAgent: false,
        executor: "is-agent",
      },
      deps
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "PRECONDITION_FAILED",
      cause: {
        reasonCode: RUN_TOOLS_MISSING,
        missing: [{ stageKey: "read", missing: ["list_playbooks"] }],
      },
    });
    expect((err as Error).message).toMatch(
      /step "Read the runs" needs list_playbooks.*Nothing was started/
    );
  });

  it("lets a run handed to an agent start (it brings its own tools)", async () => {
    await expect(
      refuseRunMissingTools(
        {
          playbook: lacking,
          ...lens,
          handedToAgent: true,
          executor: "is-agent",
        },
        deps
      )
    ).resolves.toBeUndefined();
    await expect(
      refuseRunMissingTools(
        {
          playbook: lacking,
          ...lens,
          handedToAgent: false,
          executor: "external-agent",
        },
        deps
      )
    ).resolves.toBeUndefined();
  });

  it("lets the run start when the registry cannot be read", async () => {
    await expect(
      refuseRunMissingTools(
        {
          playbook: lacking,
          ...lens,
          handedToAgent: false,
          executor: "is-agent",
        },
        failing
      )
    ).resolves.toBeUndefined();
  });
});

describe("runToolsSaveWarnings", () => {
  it("warns (never refuses) about a step whose tools a run here cannot use", async () => {
    const w = await runToolsSaveWarnings(
      { playbook: playbook(["list_playbooks"], ["list_playbooks"]), ...lens },
      deps
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(
      /will refuse to start: its step "Read the runs" needs list_playbooks/
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
      { playbook: playbook(["list_playbooks"], ["list_playbooks"]), ...lens },
      failing
    );
    expect(w[0]).toMatch(/could not be checked/);
  });
});
