import { describe, expect, it } from "vitest";
import {
  capabilityRunReasoning,
  describeEntityVerbRun,
  entityVerbRunTarget,
  isGeneratedCapabilityRunSummary,
} from "../capability-run.js";

const ID = "349d2021-3d70-41c7-974e-623c65693eba";

describe("entityVerbRunTarget", () => {
  it("reads entity.delete / entity.update with an entityId as an action on that entity", () => {
    expect(entityVerbRunTarget("entity.delete", { entityId: ID })).toEqual({
      action: "delete",
      entityId: ID,
    });
    expect(entityVerbRunTarget("entity.update", { entityId: ID })).toEqual({
      action: "update",
      entityId: ID,
    });
  });

  it("is null for create/query, other verbs, and a missing or non-uuid entityId", () => {
    expect(entityVerbRunTarget("entity.create", { entityId: ID })).toBeNull();
    expect(entityVerbRunTarget("entity.query", { entityId: ID })).toBeNull();
    expect(entityVerbRunTarget("gmail_send", { entityId: ID })).toBeNull();
    expect(
      entityVerbRunTarget("entity_facet.detach", { entityId: ID })
    ).toBeNull();
    expect(entityVerbRunTarget("entity.delete", {})).toBeNull();
    expect(entityVerbRunTarget("entity.delete", { entityId: "x" })).toBeNull();
    expect(entityVerbRunTarget(null, { entityId: ID })).toBeNull();
  });
});

describe("describeEntityVerbRun", () => {
  it("titles the run as the action on the named object", () => {
    expect(
      describeEntityVerbRun("delete", {
        kind: "question",
        name: "GRP #3: Numbers",
      })
    ).toBe('Delete Question "GRP #3: Numbers"');
  });

  it("degrades to the kind, then to the generic noun — never the id", () => {
    expect(describeEntityVerbRun("delete", { kind: "question" })).toBe(
      "Delete Question"
    );
    expect(describeEntityVerbRun("update", null)).toBe("Update entity");
    expect(describeEntityVerbRun("delete", { kind: "  ", name: "" })).toBe(
      "Delete entity"
    );
  });
});

describe("isGeneratedCapabilityRunSummary", () => {
  it("matches ONLY the generated `Run <verbId>` shape", () => {
    expect(
      isGeneratedCapabilityRunSummary("Run entity.delete", "entity.delete")
    ).toBe(true);
    expect(
      isGeneratedCapabilityRunSummary("Retire GRP #3", "entity.delete")
    ).toBe(false);
    expect(
      isGeneratedCapabilityRunSummary("Run entity.update", "entity.delete")
    ).toBe(false);
    expect(isGeneratedCapabilityRunSummary(undefined, "entity.delete")).toBe(
      false
    );
  });
});

describe("capabilityRunReasoning", () => {
  it("hoists a non-blank parameters.reasoning", () => {
    expect(capabilityRunReasoning({ reasoning: "  superseded  " })).toBe(
      "superseded"
    );
    expect(capabilityRunReasoning({ reasoning: " " })).toBeUndefined();
    expect(capabilityRunReasoning({ reasoning: 3 })).toBeUndefined();
    expect(capabilityRunReasoning(undefined)).toBeUndefined();
  });
});
