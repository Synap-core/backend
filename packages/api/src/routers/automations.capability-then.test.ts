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
  it("forwards everything the deriver produced, with a humanized label", () => {
    // ⚠️ This asserted `{key,label,required}` EXACTLY — with a fixture that
    // passes a `description` — so it pinned the drop as correct. The deriver
    // had captured that description and the projection threw it away, and this
    // test said that was the contract. A `type` was dropped the same way, which
    // is why every action param reached the phone as a bare text box.
    const params = paramsFromVerbSchema({
      query: { required: true, description: "the search text", type: "string" },
      num_results: { required: false, type: "number" },
      mode: { required: false, type: "enum", options: ["fast", "deep"] },
    });
    expect(params).toEqual([
      {
        key: "query",
        label: "Query",
        required: true,
        type: "string",
        description: "the search text",
      },
      // humanizeToken is the ONE door — snake_case becomes words, never a raw token.
      {
        key: "num_results",
        label: "Num results",
        required: false,
        type: "number",
      },
      {
        key: "mode",
        label: "Mode",
        required: false,
        type: "enum",
        options: ["fast", "deep"],
      },
    ]);
  });

  it("omits a type it cannot vouch for rather than guessing one", () => {
    // A provider verb has no declared type. Absent must stay absent: a client
    // degrades to an untyped input, which is honest. Inferring one from the
    // key's name is the substring-guessing that mistyped a `budget` number.
    const params = paramsFromVerbSchema({
      account_id: { required: true },
      amount: { required: false, type: "nonsense" },
    });
    expect(params).toEqual([
      { key: "account_id", label: "Account id", required: true },
      { key: "amount", label: "Amount", required: false },
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
