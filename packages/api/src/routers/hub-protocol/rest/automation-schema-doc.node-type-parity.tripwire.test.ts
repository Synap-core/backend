/**
 * TRIPWIRE — the served automation schema documents EVERY node type the
 * executor accepts.
 *
 * THE DEFECT (live-dogfooded 2026-09-12, D5): `AUTOMATION_SCHEMA.nodeTypes` was
 * a hand-written object literal and fell behind `FLOW_NODE_TYPES`. It declared
 * ten of twenty-three types, silently omitting `playbook_run` and `capability`.
 * `GET /api/hub/automations/schema` is the ONLY machine-readable description of
 * the DSL — `synap automation schema` and every AI authoring from it read this
 * document — so an omitted type is a type no agent can emit, even though
 * `validateFlowDefinition` would have accepted it.
 *
 * The fix is a DERIVATION (`Object.fromEntries(FLOW_NODE_TYPES.map(...))`) over
 * a `Record<(typeof FLOW_NODE_TYPES)[number], NodeTypeDoc>`, so an undocumented
 * new node type is a COMPILE error. This tripwire is the runtime half: it proves
 * the served set equals the executor's set, both ways, and that the entries
 * carry real content rather than empty shells.
 *
 * WHAT IT DOES NOT COVER: whether a doc entry's `fields` match the node's actual
 * TypeScript `data` shape. It asserts presence + non-emptiness of the
 * description, not field-level fidelity.
 */

import { describe, it, expect } from "vitest";
import { AUTOMATION_SCHEMA } from "./automation-schema-doc.js";
import { FLOW_NODE_TYPES } from "../../../services/automations/validate-flow.js";

const served = Object.keys(AUTOMATION_SCHEMA.nodeTypes);

describe("automation schema doc — node types are DERIVED from the executor", () => {
  it("the scan is non-vacuous (the executor declares a plausible number of types)", () => {
    // A guard over an empty list passes every assertion after it.
    expect(FLOW_NODE_TYPES.length).toBeGreaterThanOrEqual(20);
    expect(served.length).toBeGreaterThanOrEqual(20);
  });

  it("documents EVERY node type the executor accepts (no omissions)", () => {
    const missing = FLOW_NODE_TYPES.filter((t) => !served.includes(t));
    expect(missing).toEqual([]);
  });

  it("documents NOTHING the executor rejects (no phantom types)", () => {
    const phantom = served.filter(
      (t) => !(FLOW_NODE_TYPES as readonly string[]).includes(t)
    );
    expect(phantom).toEqual([]);
  });

  it("names the two types the stale hand list omitted", () => {
    // The exact D5 regression, pinned by name.
    expect(served).toContain("playbook_run");
    expect(served).toContain("capability");
  });

  it("every entry carries a real description (not an empty shell)", () => {
    for (const [name, def] of Object.entries(AUTOMATION_SCHEMA.nodeTypes)) {
      expect(def, name).toBeDefined();
      expect(typeof def.description, name).toBe("string");
      expect(def.description.length, name).toBeGreaterThan(10);
    }
  });
});
