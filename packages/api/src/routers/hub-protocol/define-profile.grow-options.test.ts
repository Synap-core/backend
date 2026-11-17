/**
 * Option C of decision fa6c8833 at the kind door: re-declaring an EXISTING
 * field with its allowed values PLUS new ones adds them through the
 * property-def EDIT door (governed: an agent gets a proposal), each judged by
 * `addEnumOptionRefusal`. Anything else about an existing field is reported
 * `unchanged` and files nothing (ticket fd146324): the create door never
 * rewrites a stored definition, so only a changed LINK setting still goes
 * there. A JOIN gate on the fields reads as `join_required` (a51e36e4).
 *
 * Drives the REAL `defineProfile` with a recording caller; the stored schema
 * is stubbed at the `ProfileResolutionService` boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProfileResolutionService,
  type EffectiveProperty,
} from "@synap/database";
import { defineProfile } from "./define-profile.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function stored(overrides: Partial<EffectiveProperty> = {}): EffectiveProperty {
  return {
    id: "def-1",
    slug: "uo_category",
    valueType: "string",
    required: false,
    defaultValue: null,
    displayOrder: 0,
    isLifecycle: false,
    constraints: { enum: ["preferences", "habits"] },
    uiHints: {},
    ...overrides,
  } as unknown as EffectiveProperty;
}

async function declare(
  enumValues: string[],
  storedField: EffectiveProperty,
  extra: Record<string, unknown> = {}
) {
  vi.spyOn(
    ProfileResolutionService.prototype,
    "getEffectiveProperties"
  ).mockResolvedValue([storedField]);
  const calls = {
    create: [] as Array<Record<string, unknown>>,
    update: [] as Array<Record<string, unknown>>,
  };
  const caller = {
    profiles: {
      createProfile: async () => ({
        existing: true,
        profile: { id: "p1", scope: "system", profileKind: "kind" },
      }),
      createPropertyDefs: async (input: {
        fields: Array<{ slug: string }>;
      }) => {
        calls.create.push(input);
        return {
          status: "applied",
          properties: input.fields.map((f) => ({
            slug: f.slug,
            status: "unchanged",
          })),
        };
      },
      updatePropertyDef: async (input: Record<string, unknown>) => {
        calls.update.push(input);
        return { status: "proposed", proposalId: "prop-1" };
      },
    },
  };
  const outcome = await defineProfile(
    caller as never,
    {
      userId: USER,
      workspaceId: WS,
      slug: "user_observation",
      displayName: "User observation",
      profileKind: "kind",
      fields: [
        {
          slug: "uo_category",
          valueType: "string",
          constraints: { enum: enumValues },
          ...extra,
        },
      ],
      agentUserId: "33333333-3333-4333-8333-333333333333",
    },
    { door: "synap_define_kind", fieldsParam: "properties" }
  );
  expect(outcome.ok).toBe(true);
  const result = (outcome as unknown as { result: { properties: unknown[] } })
    .result;
  return { calls, field: result.properties[0] as Record<string, unknown> };
}

afterEach(() => vi.restoreAllMocks());

describe("defineProfile — a re-declared field grows its allowed values", () => {
  it("files the new value through the edit door, keeping the stored ones", async () => {
    const { calls, field } = await declare(
      ["preferences", "habits", "rituals"],
      stored()
    );
    expect(calls.create).toEqual([]);
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({
      propertyDefId: "def-1",
      constraints: { enum: ["preferences", "habits", "rituals"] },
    });
    expect(field).toMatchObject({
      status: "proposed",
      optionsAdded: ["rituals"],
    });
  });

  it("refuses a near twin of an allowed value and files nothing", async () => {
    const { calls, field } = await declare(
      ["preferences", "habits", "habit"],
      stored()
    );
    expect(calls.update).toEqual([]);
    expect(field).toMatchObject({
      status: "unchanged",
      optionsRefused: [
        { value: "habit", reason: "close_match", closest: "habits" },
      ],
    });
  });

  it("never grows the kind's status field", async () => {
    const { calls, field } = await declare(
      ["preferences", "habits", "rituals"],
      stored({ isLifecycle: true })
    );
    expect(calls.update).toEqual([]);
    expect(field).toMatchObject({
      optionsRefused: [{ value: "rituals", reason: "lifecycle" }],
    });
  });

  it("a declaration that drops a stored value is not a growth: reported unchanged, nothing filed (fd146324)", async () => {
    const { calls, field } = await declare(["preferences", "rituals"], stored());
    expect(calls.update).toEqual([]);
    // Never a create proposal for a slug that already exists: approving it
    // could only apply nothing.
    expect(calls.create).toEqual([]);
    expect(field).toMatchObject({ status: "unchanged", propertyDefId: "def-1" });
    expect(String(field.message)).toContain("updatePropertyDef");
  });

  it("the kind's status field, re-declared with other values, points to the lifecycle door and files nothing (fd146324)", async () => {
    const { calls, field } = await declare(
      ["rituals"],
      stored({ isLifecycle: true })
    );
    expect(calls.update).toEqual([]);
    expect(calls.create).toEqual([]);
    expect(field).toMatchObject({ status: "unchanged" });
    expect(String(field.message)).toContain("changeLifecycleOptions");
  });

  it("CONTROL — a re-declared link setting (required) still rides the create batch, which re-links it", async () => {
    const { calls } = await declare(["preferences", "rituals"], stored(), {
      required: true,
    });
    expect(calls.create).toHaveLength(1);
  });
});

describe("defineProfile — a workspace JOIN gate on the fields (ticket a51e36e4)", () => {
  it("reports join_required with the join's id, never 'proposed' with it as the fields' proposal", async () => {
    vi.spyOn(
      ProfileResolutionService.prototype,
      "getEffectiveProperties"
    ).mockResolvedValue([]);
    const caller = {
      profiles: {
        createProfile: async () => ({
          existing: true,
          profile: { id: "p1", scope: "workspace", profileKind: "kind" },
        }),
        createPropertyDefs: async () => ({
          status: "proposed",
          proposalId: "join-1",
          proposalType: "join",
          deferred: true,
        }),
      },
    };
    const outcome = await defineProfile(
      caller as never,
      {
        userId: USER,
        workspaceId: WS,
        slug: "user_observation",
        displayName: "User observation",
        fields: [
          { slug: "mood", valueType: "string" },
          { slug: "energy", valueType: "number" },
        ],
        agentUserId: "33333333-3333-4333-8333-333333333333",
      },
      { door: "synap_define_kind", fieldsParam: "properties" }
    );
    expect(outcome.ok).toBe(true);
    const result = (
      outcome as unknown as {
        result: {
          properties: Array<Record<string, unknown>>;
          fieldsProposal: Record<string, unknown>;
        };
      }
    ).result;
    for (const f of result.properties) {
      expect(f).toMatchObject({
        status: "join_required",
        joinProposalId: "join-1",
      });
      expect(f).not.toHaveProperty("proposalId");
    }
    expect(result.fieldsProposal).toMatchObject({
      status: "join_required",
      proposalId: "join-1",
    });
    expect(String(result.fieldsProposal.message)).toContain("JOIN");
    expect(String(result.fieldsProposal.message)).not.toContain(
      "approving it adds them all"
    );
  });
});
