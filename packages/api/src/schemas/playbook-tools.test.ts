/**
 * The ONE tools list at the write door (0419; plan 08e4fba7 decisions 3 and 4):
 * `playbookToolsSchema` and the ONE fold, `foldPlaybookTools`, every write
 * door runs before its gate. Pure: driven through the real schema and fold.
 */
import { describe, expect, it } from "vitest";
import {
  capabilityEntriesOf,
  describeStageToolsOutside,
  foldPlaybookTools,
  playbookDefinitionSchema,
  playbookToolsSchema,
} from "./playbook-definition.js";

describe("playbookToolsSchema", () => {
  it("accepts run tools, intent slugs and capability names", () => {
    expect(
      playbookToolsSchema.safeParse(["update_document", "send_message", "fireflies"])
        .success
    ).toBe(true);
  });

  it("refuses a duplicate, an empty entry, and a list past the cap", () => {
    expect(playbookToolsSchema.safeParse(["a", "a"]).error?.issues[0].message).toContain(
      "repeats"
    );
    expect(playbookToolsSchema.safeParse([" "]).success).toBe(false);
    expect(
      playbookToolsSchema.safeParse(Array.from({ length: 65 }, (_, i) => `t${i}`))
        .error?.issues[0].message
    ).toContain("at most 64");
  });

  it("the ONE definition schema carries it (a door that extends it cannot drop it)", () => {
    const parsed = playbookDefinitionSchema.parse({
      name: "x",
      goalTemplate: "Do x",
      tools: ["update_document"],
    });
    expect(parsed.tools).toEqual(["update_document"]);
  });
});

describe("foldPlaybookTools — the one fold at the write door", () => {
  it("an input that declares nothing leaves the list alone (undefined), and finds nothing outside", () => {
    expect(foldPlaybookTools({})).toEqual({
      tools: undefined,
      stages: undefined,
      outside: [],
    });
  });

  it("folds tools, then requiredIntents, then a package's grants, then stage grants, each once", () => {
    const out = foldPlaybookTools({
      tools: ["update_document", "send_message"],
      requiredIntents: ["send_message", "search_external"],
      grants: ["fireflies"],
      stages: [
        { key: "a", grants: [{ kind: "skill", id: "source-triage" }] },
        { key: "b" },
      ],
    });
    expect(out.tools).toEqual([
      "update_document",
      "send_message",
      "search_external",
      "fireflies",
      "source-triage",
    ]);
    expect(out.stages).toEqual([
      { key: "a", tools: ["source-triage"] },
      { key: "b" },
    ]);
    expect(out.outside).toEqual([]);
  });

  it("finds a stage entry the playbook does not list (the door refuses it)", () => {
    const out = foldPlaybookTools({
      tools: ["update_document"],
      stages: [{ key: "draft", tools: ["update_document", "web_search"] }],
    });
    expect(out.outside).toEqual([{ stageKey: "draft", outside: ["web_search"] }]);
    expect(describeStageToolsOutside(out.outside)).toMatch(
      /Stage "draft" lists "web_search".*Nothing was saved/
    );
  });

  it("checks against the row's list when the input does not set one", () => {
    const stages = [{ key: "draft", tools: ["web_search"] }];
    expect(foldPlaybookTools({ stages }, ["web_search"]).outside).toEqual([]);
    expect(foldPlaybookTools({ stages }, ["update_document"]).outside).toHaveLength(1);
  });
});

describe("capabilityEntriesOf — the names a package's governance grants come from", () => {
  it("keeps capabilities, drops run tools and intent slugs", () => {
    expect(
      capabilityEntriesOf(["update_document", "search_external", "exa_search", "source-triage"])
    ).toEqual(["exa_search", "source-triage"]);
  });
});
