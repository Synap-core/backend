/**
 * The derivations and the input check of `define-tool.ts`, against the real
 * definitions (no DB): what a caller sends is refused or parsed BEFORE any
 * handler runs, and every fact a mirror reads comes from the definition.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalToolName,
  definedToolNames,
  entryToolNames,
  parseToolArgs,
  toolDefinition,
  toolExposure,
  toolGroupMembers,
  toolTeachingKeys,
  unlistedToolNames,
  wireTools,
} from "./define-tool.js";
import { visibleToolNames } from "./tool-profiles.js";

const refusal = (name: string, args: Record<string, unknown>) => {
  const out = parseToolArgs(name, args);
  expect(out.ok, JSON.stringify(args)).toBe(false);
  return out.ok ? "" : (out.result.content[0] as { text: string }).text;
};

describe("the input check", () => {
  it("every tool's input is a zod object whose wire schema is derived from it", () => {
    const names = definedToolNames();
    expect(names.length).toBeGreaterThan(100);
    const wire = new Map(wireTools().map((t) => [t.name, t.inputSchema]));
    const broken = names.filter((n) => {
      const shape = Object.keys(toolDefinition(n)!.input.shape);
      const props = Object.keys(wire.get(n)?.properties ?? {});
      return !shape.every((k) => props.includes(k));
    });
    expect(broken).toEqual([]);
  });

  it("an unknown key is REFUSED, naming it, the likely meant key and the valid inputs", () => {
    const text = refusal("synap_get_entities", {
      profileSlug: "task",
      sort: "title",
    });
    expect(text).toContain("does not take `sort`");
    expect(text).toContain("NOTHING WAS CHANGED");
    expect(text).toContain("did you mean `sortBy`?");
    expect(text).toMatch(/Valid inputs: .*profileSlug/);
  });

  it("a wrong type is refused with its path, before the handler", () => {
    const text = refusal("synap_get_entities", {
      profileSlug: "task",
      limit: "ten",
    });
    expect(text).toContain("synap_get_entities: invalid input");
    expect(text).toContain("limit");
  });

  it("a missing required input is refused", () => {
    const text = refusal("synap_ask", {});
    expect(text).toContain("query");
  });

  it("the handler gets the PARSED input: a null optional is dropped, nested keys are kept", () => {
    const out = parseToolArgs("synap_get_entities", {
      profileSlug: "task",
      limit: null,
    });
    expect(out).toEqual({ ok: true, args: { profileSlug: "task" } });

    const capture = parseToolArgs("synap_capture", {
      entities: [
        { ref: "a", profileSlug: "note", properties: { anyField: 1 } },
      ],
    });
    expect(capture.ok).toBe(true);
    if (capture.ok) {
      expect(
        (capture.args.entities as Array<Record<string, unknown>>)[0]
      ).toMatchObject({ properties: { anyField: 1 } });
    }
  });

  it("the lens the door injects is never an unknown key", () => {
    const out = parseToolArgs("synap_get_session", {
      sessionId: "6b0c1c52-9a1f-4f1b-8c3e-0d8f8a1b2c3d",
      workspaceId: "w1",
      projectId: "p1",
    });
    expect(out.ok).toBe(true);
  });

  it("an old name is checked against its tool's schema", () => {
    expect(canonicalToolName("synap_list_widgets")).toBe("synap_list_cells");
    expect(parseToolArgs("synap_list_widgets", {}).ok).toBe(true);
    expect(refusal("synap_list_widgets", { bogus: 1 })).toContain(
      "synap_list_widgets does not take `bogus`"
    );
  });

  it("an old name with its own argument shape: taken in its names, handed over in the tool's", () => {
    expect(canonicalToolName("synap_run_playbook")).toBe(
      "synap_start_session"
    );
    const out = parseToolArgs("synap_run_playbook", {
      playbookId: "pb-1",
      subjectId: "ent-1",
      name: "Weekly review",
      runner: { agentId: "a-1" },
    });
    expect(out).toEqual({
      ok: true,
      args: {
        templateId: "pb-1",
        subjectEntityId: "ent-1",
        playbookName: "Weekly review",
        runner: { agentId: "a-1" },
        launch: true,
      },
    });
    // The tool's own names are not the old name's inputs.
    expect(refusal("synap_run_playbook", { templateId: "pb-1" })).toContain(
      "synap_run_playbook does not take `templateId`"
    );
    // Two old names for one input: one is refused, never a silent pick.
    expect(
      refusal("synap_run_playbook", { playbookName: "A", name: "B" })
    ).toContain("are the same input");
    // A wrong type is said in the caller's names.
    expect(
      refusal("synap_run_playbook", { playbookId: "pb-1", startAnother: "yes" })
    ).toContain("startAnother");
    expect(
      refusal("synap_run_playbook", { playbookId: 42 })
    ).toContain("playbookId");
  });

  it("an unknown tool passes through: the dispatch says it is unknown", () => {
    expect(parseToolArgs("synap_no_such_tool", { x: 1 })).toEqual({
      ok: true,
      args: { x: 1 },
    });
  });
});

describe("what is derived from the definitions", () => {
  it("entry and group members: listed tools only; old names stay callable", () => {
    expect(entryToolNames()).toContain("synap_start_session");
    expect(entryToolNames()).not.toContain("synap_run_playbook");
    expect(entryToolNames(true)).toContain("synap_run_playbook");
    expect(toolGroupMembers().build).not.toContain("synap_list_widgets");
    expect(toolGroupMembers(true).build).toContain("synap_list_widgets");
    expect(
      visibleToolNames({ profile: "entry", groups: [] })!.has(
        "synap_run_playbook"
      )
    ).toBe(true);
  });

  it("the frozen connector names still answer, unlisted (run_playbook, start_stage_session, list_widgets); the data create doors stay listed in their group", () => {
    const unlisted = unlistedToolNames();
    for (const name of [
      "synap_run_playbook",
      "synap_start_stage_session",
      "synap_list_widgets",
    ]) {
      expect(unlisted.has(name), name).toBe(true);
      expect(toolDefinition(name), name).toBeDefined();
    }
    for (const name of ["synap_create_entity", "synap_create_document"]) {
      expect(unlisted.has(name), name).toBe(false);
      expect(toolGroupMembers().data, name).toContain(name);
      expect(entryToolNames(), name).not.toContain(name);
    }
  });

  it("an old name with its own shape advertises the OLD argument names, each with its tool's schema", () => {
    const wire = new Map(wireTools().map((t) => [t.name, t]));
    const old = wire.get("synap_run_playbook")!;
    const start = wire.get("synap_start_session")!.inputSchema.properties!;
    expect(Object.keys(old.inputSchema.properties!).sort()).toEqual(
      [
        "agentIds",
        "handToAgentId",
        "name",
        "params",
        "parentSessionId",
        "playbookId",
        "playbookName",
        "projectId",
        "reasoning",
        "runner",
        "sessionId",
        "stageRunners",
        "startAnother",
        "subjectId",
        "suspendedIntent",
        "trackId",
        "workspaceId",
      ].sort()
    );
    expect(old.inputSchema.properties!.playbookId).toEqual(start.templateId);
    expect(old.inputSchema.properties!.subjectId).toEqual(
      start.subjectEntityId
    );
    expect(old.inputSchema.required ?? []).toEqual([]);
    expect(old.description).toContain("launch: true");
    expect(old.description).toContain("playbookId = templateId");
  });

  it("teaching keys: what a tool teaches, then its own name", () => {
    expect(toolTeachingKeys().synap_create_entity).toEqual([
      "entity.create",
      "create_entity",
      "synap_create_entity",
    ]);
    expect(toolTeachingKeys().synap_orient).toEqual(["synap_orient"]);
  });

  it("exposure: every answering name, its group, and why the connector omits it", () => {
    const exposure = toolExposure();
    expect(exposure.synap_list_widgets).toMatchObject({
      group: "build",
      aliasOf: "synap_list_cells",
    });
    expect(exposure.synap_wait_for_answer!.cpOmit).toBeTruthy();
    expect(exposure.synap_run_playbook).toMatchObject({
      group: "entry",
      aliasOf: "synap_start_session",
    });
    expect(exposure.synap_ask).toEqual({ group: "entry" });
  });
});
