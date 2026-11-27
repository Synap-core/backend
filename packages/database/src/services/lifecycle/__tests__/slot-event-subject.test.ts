/**
 * The event schema's subject id (finding 5226a61b). A slot has no row of its
 * own: its transition names it `<session id>/<slot key>`, and until 27 Nov 2026
 * the schema's bare uuid check refused that log row, so every slot transition
 * failed forever in the transition outbox. Every OTHER subject stays a uuid.
 *
 * Does NOT cover: whether the outbox dispatcher hands a slot transition to the
 * log (that path is the dispatcher's; this pins the schema that refused it).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { SynapEventSchema } from "@synap-core/core";

const base = () => ({
  id: randomUUID(),
  version: "v1" as const,
  type: "slot.transition.completed",
  data: {},
  userId: "u1",
});

describe("event subject id", () => {
  it("accepts a slot's <session uuid>/<slot key>", () => {
    const r = SynapEventSchema.safeParse({
      ...base(),
      subjectType: "slot",
      subjectId: `${randomUUID()}/pull-request`,
    });
    expect(r.success).toBe(true);
  });

  it("refuses a slot id whose session part is not a uuid, or that has no key", () => {
    for (const subjectId of [
      "repo:backend/pr",
      "/pr",
      `${randomUUID()}/`,
      "pr",
    ]) {
      const r = SynapEventSchema.safeParse({
        ...base(),
        subjectType: "slot",
        subjectId,
      });
      expect(r.success, subjectId).toBe(false);
    }
  });

  it("still refuses a non-uuid for every other subject type", () => {
    for (const subjectType of [
      "entity",
      "focus_session",
      "proposal",
      undefined,
    ]) {
      const r = SynapEventSchema.safeParse({
        ...base(),
        subjectType,
        subjectId: `${randomUUID()}/pull-request`,
      });
      expect(r.success, String(subjectType)).toBe(false);
    }
  });

  it("keeps accepting a uuid subject and no subject at all", () => {
    expect(
      SynapEventSchema.safeParse({
        ...base(),
        subjectType: "entity",
        subjectId: randomUUID(),
      }).success
    ).toBe(true);
    expect(SynapEventSchema.safeParse(base()).success).toBe(true);
  });

  it("keeps the object shape readable (a tripwire reads .shape.source)", () => {
    expect(SynapEventSchema.shape.source.safeParse("api").success).toBe(true);
  });
});
