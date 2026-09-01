/**
 * Rules-ecosystem "THEN" menu — the CAPABILITY-VERB tier (SLICE 2).
 *
 * When a rule is scoped to a capability, `availableActions` also offers that
 * capability's RUNNABLE verbs as THEN actions that compile to a `type:"capability"`
 * flow node. These are PURE-LOGIC tests over the two shared projection helpers —
 * no Postgres: the DB read that feeds them (`listCapabilities` →
 * `projectRunnableActions`) yields the `RunnableCapabilityAction[]` these tests
 * supply directly. The runnable FLOOR (governance:auto + connected + executable)
 * is `projectRunnableActions`' own contract, tested next to it.
 */
import { describe, expect, it } from "vitest";
import {
  paramsFromVerbSchema,
  capabilityActionOptions,
} from "./automations.js";
import type { RunnableCapabilityAction } from "../services/capabilities/action-projection.js";

describe("paramsFromVerbSchema (verb params → activate-gate shape)", () => {
  it("projects each param to {key,label,required} with a humanized label", () => {
    const params = paramsFromVerbSchema({
      query: { required: true, description: "the search text" },
      num_results: { required: false },
    });
    expect(params).toEqual([
      { key: "query", label: "Query", required: true },
      // humanizeToken is the ONE door — snake_case becomes words, never a raw token.
      { key: "num_results", label: "Num results", required: false },
    ]);
  });

  it("treats a non-object / missing-required spec as NOT required (honest floor)", () => {
    const params = paramsFromVerbSchema({ q: "string", flag: null });
    expect(params).toEqual([
      { key: "q", label: "Q", required: false },
      { key: "flag", label: "Flag", required: false },
    ]);
  });

  it("returns [] for a verb with no params", () => {
    expect(paramsFromVerbSchema({})).toEqual([]);
  });
});

describe("capabilityActionOptions (runnable verbs → capability THEN options)", () => {
  const runnable = (
    over: Partial<RunnableCapabilityAction>
  ): RunnableCapabilityAction => ({
    label: "Search the web",
    tool: "Exa",
    governance: "auto",
    parameters: {},
    ...over,
  });

  it("maps a verb to a capability ActionOption keyed on verbId", () => {
    const [opt, ...rest] = capabilityActionOptions(
      [
        runnable({
          verbId: "search.web",
          label: "Search the web",
          parameters: { query: { required: true } },
        }),
      ],
      "11111111-1111-1111-1111-111111111111"
    );
    expect(rest).toHaveLength(0);
    expect(opt).toEqual({
      key: "verb:search.web",
      label: "Search the web",
      nodeType: "capability",
      capabilityId: "11111111-1111-1111-1111-111111111111",
      verbId: "search.web",
      params: [{ key: "query", label: "Query", required: true }],
    });
  });

  it("SKIPS a skill-only action (no verbId) — it has no capability node to emit", () => {
    const opts = capabilityActionOptions(
      [runnable({ skillId: "skill-1", label: "A skill", verbId: undefined })],
      "11111111-1111-1111-1111-111111111111"
    );
    expect(opts).toEqual([]);
  });

  it("emits one option per runnable verb, preserving order", () => {
    const opts = capabilityActionOptions(
      [
        runnable({ verbId: "mail.send", label: "Send mail" }),
        runnable({ verbId: "mail.search", label: "Search mail" }),
      ],
      "22222222-2222-2222-2222-222222222222"
    );
    expect(opts.map((o) => o.verbId)).toEqual(["mail.send", "mail.search"]);
    expect(opts.every((o) => o.nodeType === "capability")).toBe(true);
  });
});
