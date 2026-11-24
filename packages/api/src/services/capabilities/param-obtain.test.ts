/**
 * `obtain` on a capability param (finding 91a3bfd3): the steps a person
 * follows to get a key, declared in the manifest, with the `act` ask's bounds
 * (at most 7 steps of at most 200 characters) and an https url only.
 *
 *  - the Hub door's definition schema REFUSES an out-of-bounds `obtain`;
 *  - the read side (`extractInstallParams`, which the proposal's setup row
 *    and the capability card both read) carries a valid one and DROPS an
 *    invalid one, never half of it.
 */
import { describe, expect, it } from "vitest";
import { ASK_LIMITS } from "@synap-core/types/ask";
import { ParamObtainSchema, readParamObtain } from "./param-obtain.js";
import { extractInstallParams } from "./capability-catalog.js";
import { CapabilityDefinitionSchema } from "../../routers/hub-protocol/rest/capabilities.js";
import type { CapabilityDefinition } from "@synap/playbooks";

const OK = {
  url: "https://app.cal.com/settings/developer/api-keys",
  steps: ["Open Settings, then Developer, then API Keys", "Create a key"],
};

const definition = (obtain: unknown) => ({
  key: "cal-com",
  name: "Cal.com",
  params: [
    { name: "calApiKey", label: "Cal.com API key", required: true, obtain },
  ],
});

describe("obtain bounds — the act ask's", () => {
  it("accepts steps with an https url, and steps alone", () => {
    expect(ParamObtainSchema.safeParse(OK).success).toBe(true);
    expect(ParamObtainSchema.safeParse({ steps: ["Do it"] }).success).toBe(
      true
    );
  });

  it.each([
    ["an http url", { ...OK, url: "http://app.cal.com/keys" }],
    ["a javascript: url", { ...OK, url: "javascript:alert(1)" }],
    ["no steps", { url: OK.url, steps: [] }],
    [
      "more steps than an act ask takes",
      { steps: Array.from({ length: ASK_LIMITS.stepsMax + 1 }, () => "x") },
    ],
    ["a step too long", { steps: ["x".repeat(ASK_LIMITS.stepMaxChars + 1)] }],
    ["an empty step", { steps: ["  "] }],
    ["an unknown field", { ...OK, video: "https://x.test" }],
  ])("refuses %s", (_name, obtain) => {
    expect(ParamObtainSchema.safeParse(obtain).success).toBe(false);
    expect(readParamObtain(obtain)).toBeUndefined();
  });

  it("the Hub door refuses a definition whose obtain is out of bounds", () => {
    expect(CapabilityDefinitionSchema.safeParse(definition(OK)).success).toBe(
      true
    );
    const parsed = CapabilityDefinitionSchema.safeParse(
      definition({ ...OK, url: "http://app.cal.com/keys" })
    );
    expect(parsed.success).toBe(false);
  });

  it("the Hub door keeps a valid obtain (not stripped as an unknown key)", () => {
    const parsed = CapabilityDefinitionSchema.parse(definition(OK));
    expect(parsed.params?.[0]?.obtain).toEqual(OK);
  });
});

describe("the read side carries a valid obtain and drops an invalid one", () => {
  it("a valid obtain reaches the install param", () => {
    const [param] = extractInstallParams(
      definition(OK) as unknown as CapabilityDefinition
    );
    expect(param?.obtain).toEqual(OK);
  });

  it("an invalid one is absent, never half-projected", () => {
    const [param] = extractInstallParams(
      definition({
        url: "http://app.cal.com/keys",
        steps: ["ok"],
      }) as unknown as CapabilityDefinition
    );
    expect(param).toBeDefined();
    expect("obtain" in param!).toBe(false);
  });

  it("a param with no obtain is unchanged", () => {
    const [param] = extractInstallParams(
      definition(undefined) as unknown as CapabilityDefinition
    );
    expect("obtain" in param!).toBe(false);
  });
});
