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
  inputValidator,
  parseToolArgs,
  toolDefinition,
  toolExposure,
  toolGroupMembers,
  toolTeachingKeys,
  unlistedToolNames,
} from "./define-tool.js";
import { visibleToolNames } from "./tool-profiles.js";

const refusal = async (name: string, args: Record<string, unknown>) => {
  const out = await parseToolArgs(name, args);
  expect(out.ok, JSON.stringify(args)).toBe(false);
  return out.ok ? "" : (out.result.content[0] as { text: string }).text;
};

describe("the input check", () => {
  it("every tool's validator compiles from its declared schema", () => {
    const names = definedToolNames();
    expect(names.length).toBeGreaterThan(100);
    const broken = names.filter((n) => {
      try {
        inputValidator(toolDefinition(n)!);
        return false;
      } catch {
        return true;
      }
    });
    expect(broken).toEqual([]);
  });

  it("an unknown key is REFUSED, naming it, the likely meant key and the valid inputs", async () => {
    const text = await refusal("synap_get_entities", {
      profileSlug: "task",
      sort: "title",
    });
    expect(text).toContain("does not take `sort`");
    expect(text).toContain("NOTHING WAS CHANGED");
    expect(text).toContain("did you mean `sortBy`?");
    expect(text).toMatch(/Valid inputs: .*profileSlug/);
  });

  it("a wrong type is refused with its path, before the handler", async () => {
    const text = await refusal("synap_get_entities", {
      profileSlug: "task",
      limit: "ten",
    });
    expect(text).toContain("synap_get_entities: invalid input");
    expect(text).toContain("limit");
  });

  it("a missing required input is refused", async () => {
    const text = await refusal("synap_ask", {});
    expect(text).toContain("query");
  });

  it("the handler gets the PARSED input: a null optional is dropped, nested keys are kept", async () => {
    const out = await parseToolArgs("synap_get_entities", {
      profileSlug: "task",
      limit: null,
    });
    expect(out).toEqual({ ok: true, args: { profileSlug: "task" } });

    const capture = await parseToolArgs("synap_capture", {
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

  it("the lens the door injects is never an unknown key", async () => {
    const out = await parseToolArgs("synap_get_session", {
      sessionId: "6b0c1c52-9a1f-4f1b-8c3e-0d8f8a1b2c3d",
      workspaceId: "w1",
      projectId: "p1",
    });
    expect(out.ok).toBe(true);
  });

  it("an old name is checked against its tool's schema", async () => {
    expect(canonicalToolName("synap_list_widgets")).toBe("synap_list_cells");
    expect((await parseToolArgs("synap_list_widgets", {})).ok).toBe(true);
    expect(
      await refusal("synap_list_widgets", { bogus: 1 })
    ).toContain("synap_list_widgets does not take `bogus`");
  });

  it("an unknown tool passes through: the dispatch says it is unknown", async () => {
    expect(await parseToolArgs("synap_no_such_tool", { x: 1 })).toEqual({
      ok: true,
      args: { x: 1 },
    });
  });
});

describe("what is derived from the definitions", () => {
  it("entry and group members: listed tools only; hidden doors stay callable once unlocked", () => {
    expect(entryToolNames()).toContain("synap_start_session");
    expect(toolGroupMembers().build).not.toContain("synap_run_playbook");
    expect(toolGroupMembers().build).not.toContain("synap_list_widgets");
    expect(toolGroupMembers(true).build).toEqual(
      expect.arrayContaining(["synap_run_playbook", "synap_list_widgets"])
    );
    expect(
      visibleToolNames({ profile: "entry", groups: ["build"] })!.has(
        "synap_run_playbook"
      )
    ).toBe(true);
  });

  it("the frozen connector names still answer, unlisted (run_playbook, start_stage_session, create_entity, create_document, list_widgets)", () => {
    const unlisted = unlistedToolNames();
    for (const name of [
      "synap_run_playbook",
      "synap_start_stage_session",
      "synap_create_entity",
      "synap_create_document",
      "synap_list_widgets",
    ]) {
      expect(unlisted.has(name), name).toBe(true);
      expect(toolDefinition(name), name).toBeDefined();
    }
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
    expect(exposure.synap_run_playbook!.hidden).toBeTruthy();
    expect(exposure.synap_ask).toEqual({ group: "entry" });
  });
});
