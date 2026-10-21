/**
 * TRIPWIRE — the two rule-EDIT doors take ONE body shape.
 *
 * `skills.updateRule` (session door) and Hub REST `PATCH /rules/:id` (API-key
 * door) must accept exactly the same edit. The create pair is the cautionary
 * tale: two literal `z.object`s that happen to agree, with nothing making them
 * agree. So this compares by IDENTITY — each door's field must be the very
 * schema object `ruleEditFieldsSchema` declares — which a hand copy cannot pass
 * even when it is character-for-character equal today.
 *
 * Each door may add only what is its own: `id` on tRPC (REST carries it in the
 * path), the attribution fields on REST (`agentUserId`, `userId`, verified by
 * the route, never trusted raw).
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { ruleEditFieldsSchema } from "./update-input.js";
import { skillsRouter } from "../../routers/skills.js";
import { UpdateRuleBodySchema } from "../../routers/hub-protocol/rest/rules.js";

const SHARED = Object.keys(ruleEditFieldsSchema.shape).sort();

function trpcUpdateRuleShape(): Record<string, z.ZodType> {
  const procedure = (
    skillsRouter as unknown as {
      _def: {
        procedures: Record<
          string,
          { _def: { inputs: Array<{ shape: Record<string, z.ZodType> }> } }
        >;
      };
    }
  )._def.procedures.updateRule;
  expect(
    procedure,
    "skills.updateRule is gone — move this tripwire"
  ).toBeDefined();
  const inputs = procedure!._def.inputs;
  expect(inputs).toHaveLength(1);
  return inputs[0]!.shape;
}

describe("rule edit doors share ONE body schema", () => {
  it("skills.updateRule holds every shared field by identity, plus only `id`", () => {
    const shape = trpcUpdateRuleShape();
    for (const key of SHARED) {
      expect(shape[key], `skills.updateRule.${key} is a copy`).toBe(
        ruleEditFieldsSchema.shape[
          key as keyof typeof ruleEditFieldsSchema.shape
        ]
      );
    }
    expect(Object.keys(shape).sort()).toEqual([...SHARED, "id"].sort());
  });

  it("PATCH /rules/:id holds every shared field by identity, plus only the attribution fields", () => {
    const shape = UpdateRuleBodySchema.shape as Record<string, z.ZodType>;
    for (const key of SHARED) {
      expect(shape[key], `PATCH /rules/:id body.${key} is a copy`).toBe(
        ruleEditFieldsSchema.shape[
          key as keyof typeof ruleEditFieldsSchema.shape
        ]
      );
    }
    expect(Object.keys(shape).sort()).toEqual(
      [...SHARED, "agentUserId", "userId"].sort()
    );
  });
});
