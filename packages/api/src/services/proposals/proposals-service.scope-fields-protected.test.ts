/**
 * What a person approves with a new kind or a code skill cannot be rewritten
 * by a revise after filing (review of #199, M1 + M3).
 *
 * `kindFields` — the field defs the `profile/create` executor creates with a
 * new kind (the summary named them at filing); `requiredToolIds` /
 * `requiredToolNames` — the tools a code skill `requires`, i.e. the scope its
 * own provider calls run under without a second review. Driven through the
 * shared revise core every revise door uses (tRPC `revise`, Hub
 * `updateProposal`, MCP `synap_revise_proposal`).
 *
 * Negative control (2026-10-25, negctl/tickets-1025-7): the three keys
 * dropped from `PROTECTED_ENVELOPE_FIELDS` turn every refusal case red.
 */
import { describe, it, expect } from "vitest";
import { computeRevisedEnvelope } from "./proposals-service.js";

/** The gate's nested shape: `proposals.data = { …, data: <payload> }`. */
const kindProposal = () => ({
  requestId: "req-kind",
  targetType: "profile",
  changeType: "create",
  data: {
    slug: "social-account-audit",
    displayName: "Social account audit",
    kindFields: [{ slug: "botscore", valueType: "number" }],
  },
});

const skillProposal = () => ({
  requestId: "req-skill",
  targetType: "skill",
  changeType: "create",
  data: {
    name: "score_handle",
    code: "return 1;",
    requiredToolIds: ["7b0d9c4e-1f2a-4c3b-9d8e-5a6b7c8d9e0f"],
    requiredToolNames: ["apify_api"],
  },
});

describe("computeRevisedEnvelope — the approved scope is not revisable", () => {
  it.each([
    ["kindFields", kindProposal, [{ slug: "pwned", valueType: "string" }]],
    [
      "requiredToolIds",
      skillProposal,
      ["00000000-0000-4000-8000-000000000000"],
    ],
    ["requiredToolNames", skillProposal, ["stripe_api"]],
  ] as const)("refuses an inner patch of %s", (key, envelope, value) => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: envelope(),
        patch: { kind: "inner", fields: { [key]: value } },
      })
    ).toThrow(new RegExp(key));
  });

  it("refuses the nested form (an envelope patch carrying data.kindFields)", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: kindProposal(),
        patch: {
          kind: "envelope",
          fields: { data: { kindFields: [] } },
        },
      })
    ).toThrow(/kindFields/);
  });

  it("a wholesale data replacement cannot DROP the fields: they are restored", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: kindProposal(),
      patch: {
        kind: "envelope",
        fields: {
          data: { slug: "social-account-audit", displayName: "Audit" },
        },
      },
    });
    expect((merged.data as Record<string, unknown>).kindFields).toEqual([
      { slug: "botscore", valueType: "number" },
    ]);
    expect((merged.data as Record<string, unknown>).displayName).toBe("Audit");
  });

  it("a payload that merely uses the word `fields` (workspace projection) stays revisable", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: {
        requestId: "req-proj",
        data: { enabled: true, roles: [], fields: ["title"] },
      },
      patch: { kind: "inner", fields: { fields: ["title", "status"] } },
    });
    expect((merged.data as Record<string, unknown>).fields).toEqual([
      "title",
      "status",
    ]);
  });
});
