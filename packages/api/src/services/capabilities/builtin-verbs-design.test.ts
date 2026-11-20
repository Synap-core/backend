/**
 * design.apply's answers reach the caller as RESULTS (w5-app, 19 Nov 2026).
 *
 * A refused batch and a design changed since it was read are answers the
 * caller acts on (fix op N, read again). Thrown as a `VerbRefusal` they kept
 * only `{message, errorClass}` on the run door and reached a REST caller as a
 * redacted 500: the op index, the reasons and the catalog hash were lost and a
 * conflict looked like a crash. What the door cannot do at all (no catalog, no
 * such design) stays a refusal.
 *
 * The design door itself is stubbed: its replies are `design-door.test.ts`'s.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  reply: null as unknown,
  throws: null as Error | null,
}));

vi.mock("../designs/design-door.js", () => ({
  applyDesign: async () => {
    if (h.throws) throw h.throws;
    return h.reply;
  },
}));

import { BUILTIN_VERBS } from "./builtin-verbs.js";

const run = () =>
  BUILTIN_VERBS["design.apply"]!(
    {
      designId: "11111111-1111-4111-8111-111111111111",
      baseUpdatedAt: "2026-11-19T09:00:00.000Z",
      ops: [{ op: "remove_block", id: "Text-1" }],
    },
    { userId: "owner-1", workspaceId: null } as never
  );

beforeEach(() => {
  h.reply = null;
  h.throws = null;
});

describe("design.apply: a refusal and a conflict are answers, not failures", () => {
  it("a refused batch is returned whole: op index, reasons, catalog hash", async () => {
    h.reply = {
      status: "refused",
      opIndex: 0,
      op: "remove_block",
      reasons: [{ kind: "no-block", id: "Text-1" }],
      catalogHash: "h-1",
      message: "Op 0 (remove_block) refused, nothing was changed.",
    };
    await expect(run()).resolves.toEqual(h.reply);
  });

  it("a design changed since it was read is returned with its time now", async () => {
    h.reply = {
      status: "conflict",
      designId: "11111111-1111-4111-8111-111111111111",
      updatedAt: "2026-11-19T10:00:00.000Z",
      message: "Design changed since it was read.",
    };
    await expect(run()).resolves.toEqual(h.reply);
  });

  it("what the door cannot do at all is still a refusal (no catalog installed)", async () => {
    h.throws = new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "No design catalog on this pod.",
    });
    await expect(run()).rejects.toMatchObject({
      name: "VerbRefusal",
      errorClass: "validation",
    });
  });
});
