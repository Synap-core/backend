/**
 * An agent can declare WHO runs a playbook and the tools it needs over MCP
 * (spec 7111934d slice 1): `synap_create_playbook` and `synap_update_playbook`
 * carry `runner` / `requires` to the procedures, whose REAL input schemas
 * (`createInputSchema`, `updateInputSchema`: `playbookRunnerSchema`,
 * `requiresSchema`) keep a good value and refuse a bad one, never dropped.
 *
 * SEAM: the REAL MCP handlers → the REAL playbook doors → the input the
 * procedures receive. Only the router caller is stubbed (it needs a database).
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  creates: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../playbooks.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    playbooksRouter: {
      createCaller: () => ({
        create: async (input: Record<string, unknown>) => {
          h.creates.push(input);
          return { status: "proposed", proposalId: "p-1" };
        },
        update: async (input: Record<string, unknown>) => {
          h.updates.push(input);
          return { status: "proposed", proposalId: "p-2" };
        },
      }),
    },
  };
});

vi.mock("../../hub-protocol/utils.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createHubProtocolCallerContext: async () => ({}) };
});

import { buildHandlers } from "./build.js";
import { createInputSchema, updateInputSchema } from "../../playbooks.js";
import { tools } from "../tools/index.js";
import type { McpToolContext } from "./shared.js";

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  return {
    toolName,
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "00000000-0000-4000-8000-0000000000bb",
    requestedWorkspaceId: "00000000-0000-4000-8000-0000000000aa",
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

const RUNNER = [
  { role: "video-render", computer: "mac" },
  { role: "video-render", computer: "devbox" },
];
const REQUIRES = ["media-ffmpeg", "media-transcribe"];

describe("synap_create_playbook / synap_update_playbook carry runner and requires", () => {
  it("create forwards both, and the procedure's schema keeps them", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", {
        name: "Edit a video",
        goalTemplate: "Edit it",
        runner: RUNNER,
        requires: REQUIRES,
      })
    );
    expect(h.creates).toHaveLength(1);
    const parsed = createInputSchema.parse(h.creates[0]);
    expect(parsed.runner).toEqual(RUNNER);
    expect(parsed.requires).toEqual(REQUIRES);
  });

  it("update forwards both as a patch; null clears the runner", async () => {
    h.updates.length = 0;
    await buildHandlers.synap_update_playbook!(
      ctx("synap_update_playbook", {
        playbookId: "00000000-0000-4000-8000-0000000000cc",
        runner: null,
        requires: REQUIRES,
      })
    );
    expect(h.updates).toHaveLength(1);
    const parsed = updateInputSchema.parse(h.updates[0]);
    expect(parsed.runner).toBeNull();
    expect(parsed.requires).toEqual(REQUIRES);
  });

  it("a misspelled runner reaches the procedure's schema and is refused there", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", {
        name: "Edit a video",
        goalTemplate: "Edit it",
        runner: { agent: "claude" },
      })
    );
    expect(h.creates[0]!.runner).toEqual({ agent: "claude" });
    expect(createInputSchema.safeParse(h.creates[0]).success).toBe(false);
  });

  it("a playbook that names no runner sends none", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", { name: "Weekly", goalTemplate: "Review" })
    );
    expect("runner" in h.creates[0]!).toBe(false);
    expect("requires" in h.creates[0]!).toBe(false);
  });

  it("both tools advertise runner and requires; the shapes are taught in a skill", async () => {
    const listed = await tools.list();
    for (const name of ["synap_create_playbook", "synap_update_playbook"]) {
      const tool = listed.find((t) => t.name === name)!;
      const props = tool.inputSchema.properties as Record<string, any>;
      expect(props.runner, name).toBeDefined();
      expect(props.requires, name).toBeDefined();
      expect(String(props.runner.description)).toContain(
        "system/synap/processes"
      );
      // The stage fields are named in the stages description (token budget).
      expect(String(props.stages.description)).toMatch(
        /runner\?, uses\?, requires\?/
      );
    }
  });

  it("a stage's runner, uses and requires reach the procedure intact", async () => {
    h.creates.length = 0;
    const stages = [
      {
        key: "render",
        name: "Render",
        category: "started",
        runner: [{ role: "video-render", computer: "mac" }, "synap_ai"],
        requires: ["media-ffmpeg"],
      },
      {
        key: "sound",
        name: "Sound",
        category: "started",
        uses: {
          playbookId: "00000000-0000-4000-8000-0000000000dd",
          version: 2,
        },
      },
    ];
    await buildHandlers.synap_create_playbook!(
      ctx("synap_create_playbook", {
        name: "Edit a video",
        goalTemplate: "Edit it",
        stages,
      })
    );
    const parsed = createInputSchema.parse(h.creates[0]);
    expect(parsed.stages).toEqual(stages);
  });
});
