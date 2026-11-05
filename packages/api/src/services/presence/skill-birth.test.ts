/**
 * A skill a PERSON's door would create already ON (W3 slice 3, founder
 * decision 1): born on only with a proof of presence, or in report mode.
 * Under enforce with no proof it is born OFF; a proof that fails refuses the
 * create. An agent's skill is not decided here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const gate = vi.hoisted(() => vi.fn(async (_args: unknown) => null as unknown));
vi.mock("./gate.js", () => ({ assertPresenceForRequest: gate }));

import { bornOnUnlessUnproved, personSkillBornOn } from "./skill-birth.js";

const refusal = (reasonCode: string) =>
  new TRPCError({ code: "FORBIDDEN", message: "no", cause: { reasonCode } });
const args = { userId: "u", name: "Weekly brief", door: "skills.create" };

beforeEach(() => {
  gate.mockReset();
  gate.mockResolvedValue(null);
});

describe("personSkillBornOn", () => {
  it("asks the gate for skill:new:<name> with the proof sent", async () => {
    const proof = { kind: "device_key" } as never;
    expect(await personSkillBornOn({ ...args, proof })).toBe(true);
    expect(gate).toHaveBeenCalledWith({
      userId: "u",
      kind: "skill",
      id: "new:Weekly brief",
      proof,
      door: "skills.create",
    });
  });

  it("GUARDRAIL: enforce with no proof → born OFF, never refused", async () => {
    gate.mockRejectedValueOnce(refusal("PRESENCE_REQUIRED"));
    expect(await personSkillBornOn(args)).toBe(false);
  });

  it("a proof that fails refuses the create", async () => {
    gate.mockRejectedValueOnce(refusal("PRESENCE_INVALID"));
    await expect(personSkillBornOn(args)).rejects.toThrow();
  });
});

describe("bornOnUnlessUnproved", () => {
  it("only an ON birth by a person goes through the gate", async () => {
    expect(await bornOnUnlessUnproved(false, undefined, args)).toBe(false);
    expect(await bornOnUnlessUnproved(true, "agent-1", args)).toBe(true);
    expect(gate).not.toHaveBeenCalled();
    gate.mockRejectedValueOnce(refusal("PRESENCE_REQUIRED"));
    expect(await bornOnUnlessUnproved(true, undefined, args)).toBe(false);
  });
});
