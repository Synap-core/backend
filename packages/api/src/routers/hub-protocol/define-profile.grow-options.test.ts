/**
 * Option C of decision fa6c8833 at the kind door: re-declaring an EXISTING
 * field with its allowed values PLUS new ones adds them through the
 * property-def EDIT door (governed: an agent gets a proposal), each judged by
 * `addEnumOptionRefusal`. Anything else about an existing field still goes to
 * the create door, which never rewrites a stored definition.
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

async function declare(enumValues: string[], storedField: EffectiveProperty) {
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

  it("a declaration that drops a stored value is not a growth: the create door reports it", async () => {
    const { calls } = await declare(["preferences", "rituals"], stored());
    expect(calls.update).toEqual([]);
    expect(calls.create).toHaveLength(1);
  });
});
