/**
 * A pod agent can DECLARE a process over MCP (`synap_create_playbook`).
 *
 * The process contract (schemas/playbook-process.ts + playbookStageSchema):
 * stage `subjectStatus` / `gate` / `onFail` / `expectedOutputs`, and the
 * playbook-level `subjectProfile.statusProperty`, `activators`,
 * `humanOnlyStatuses`. Before this, the MCP door advertised none of them and
 * forwarded no activators / humanOnlyStatuses, so an agent could not author an
 * activator at all.
 *
 * SEAM: the REAL MCP handler → the REAL `createPlaybookDoor` → the input the
 * `playbooks.create` procedure receives, parsed by that procedure's REAL input
 * schema (`createInputSchema`) and folded by the REAL
 * `foldProcessIntoSubjectProfile` (what is stored). Only the router caller is
 * stubbed (it needs a database).
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ creates: [] as Array<Record<string, unknown>> }));

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
      }),
    },
  };
});

vi.mock("../../hub-protocol/utils.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createHubProtocolCallerContext: async () => ({}) };
});

import { buildHandlers } from "./build.js";
import { createInputSchema } from "../../playbooks.js";
import { foldProcessIntoSubjectProfile } from "../../../schemas/playbook-process.js";
import { tools } from "../tools/index.js";
import type { McpToolContext } from "./shared.js";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_create_playbook",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "00000000-0000-4000-8000-0000000000bb",
    requestedWorkspaceId: "00000000-0000-4000-8000-0000000000aa",
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

const PROCESS_ARGS = {
  name: "Produce a post",
  goalTemplate: "Produce {post}",
  params: [{ name: "post", type: "entity", required: true }],
  subjectProfileSlug: "post",
  statusProperty: "post-status",
  activators: [{ on: "enters_status", status: "Briefed", mode: "propose" }],
  humanOnlyStatuses: ["Idea", "Archived"],
  expectedOutputs: [
    { kind: "document", label: "Final copy", relationToSubject: "made_for" },
  ],
  stages: [
    {
      key: "draft",
      name: "Draft",
      category: "started",
      subjectStatus: "Drafting",
      expectedOutputs: [
        { kind: "document", label: "Draft", relationToSubject: "made_for" },
      ],
    },
    {
      key: "review",
      name: "Review",
      category: "started",
      subjectStatus: "Ready",
      gate: { kind: "human" },
      onFail: { toStage: "draft" },
    },
  ],
};

describe("synap_create_playbook → the process contract", () => {
  it("forwards every process field to playbooks.create, and the procedure's schema keeps them", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(ctx(PROCESS_ARGS));
    expect(h.creates).toHaveLength(1);
    const parsed = createInputSchema.parse(h.creates[0]);

    expect(parsed.activators).toEqual([
      { on: "enters_status", status: "Briefed", mode: "propose" },
    ]);
    expect(parsed.humanOnlyStatuses).toEqual(["Idea", "Archived"]);
    expect(parsed.subjectProfile).toMatchObject({
      profileSlug: "post",
      statusProperty: "post-status",
    });
    expect(parsed.expectedOutputs?.[0]).toMatchObject({
      relationToSubject: "made_for",
    });
    const [draft, review] = parsed.stages!;
    expect(draft).toMatchObject({
      subjectStatus: "Drafting",
      expectedOutputs: [
        { kind: "document", label: "Draft", relationToSubject: "made_for" },
      ],
    });
    expect(review).toMatchObject({
      subjectStatus: "Ready",
      gate: { kind: "human" },
      onFail: { toStage: "draft" },
    });

    // What the create door stores: the ONE fold puts the playbook-level
    // declarations inside subjectProfile.
    expect(foldProcessIntoSubjectProfile(parsed)).toEqual({
      profileSlug: "post",
      statusProperty: "post-status",
      activators: [{ on: "enters_status", status: "Briefed", mode: "propose" }],
      humanOnlyStatuses: ["Idea", "Archived"],
    });
  });

  it("a malformed declaration reaches the procedure's schema and is refused there, never dropped", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx({ ...PROCESS_ARGS, activators: [{ on: "enters_status" }] })
    );
    expect(h.creates[0]!.activators).toEqual([{ on: "enters_status" }]);
    expect(createInputSchema.safeParse(h.creates[0]).success).toBe(false);
  });

  it("a playbook that declares no process sends none of the process keys", async () => {
    h.creates.length = 0;
    await buildHandlers.synap_create_playbook!(
      ctx({ name: "Weekly", goalTemplate: "Review" })
    );
    for (const k of [
      "activators",
      "humanOnlyStatuses",
      "expectedOutputs",
      "subjectProfile",
    ]) {
      expect(k in h.creates[0]!).toBe(false);
    }
  });

  it("the advertised tool schema teaches every process field", async () => {
    const tool = (await tools.list()).find(
      (t) => t.name === "synap_create_playbook"
    )!;
    const props = tool.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    for (const k of [
      "statusProperty",
      "activators",
      "humanOnlyStatuses",
      "expectedOutputs",
    ]) {
      expect(props[k], k).toBeDefined();
    }
    const stageProps = (props.stages!.items as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    for (const k of ["subjectStatus", "gate", "onFail", "expectedOutputs"]) {
      expect(stageProps[k], k).toBeDefined();
    }
    // Derived from the activator schema, not re-typed: its closed enums arrive.
    const activatorItem = (props.activators!.items ?? {}) as {
      properties: Record<string, { enum?: string[] }>;
    };
    // Stage workers (work model L4) arrive the same way.
    expect(activatorItem.properties.on!.enum).toEqual([
      "created",
      "enters_status",
      "count",
      "schedule",
      "manual",
    ]);
    expect(activatorItem.properties.size!.enum).toEqual([
      "per_thing",
      "per_moment",
    ]);
    expect(activatorItem.properties.mode!.enum).toEqual(["run", "propose"]);
    expect(tool.description).toContain("system/synap/processes");
  });
});
