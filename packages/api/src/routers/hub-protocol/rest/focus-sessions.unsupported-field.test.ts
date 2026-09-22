/**
 * PATCH /focus-sessions/:id must REFUSE `completeOutput`, not swallow it.
 *
 * Reproduced live against the pod: PATCHing `{"completeOutput": "<label>"}`
 * returned HTTP 200 with the full session, the slot still `pending`, and no
 * mention of the field anywhere. The cause was not the governance floor — this
 * door never declared `completeOutput` at all, so zod (which strips undeclared
 * keys) dropped it before any code could look at it. An agent parses that 200
 * as the deliverable being marked done.
 *
 * Pure — no DB, no HTTP (mirrors `confine-workspace.test.ts`).
 */

import { describe, it, expect } from "vitest";
import { unsupportedUpdateFieldError } from "./focus-sessions.js";

describe("PATCH /focus-sessions/:id — unsupported fields are refused", () => {
  it("refuses completeOutput with a message naming the right door", () => {
    const err = unsupportedUpdateFieldError({ completeOutput: "Signed NDA" });
    expect(err).toBeTruthy();
    // The refusal has to be ACTIONABLE: knowing it was refused is useless
    // without knowing where the capability actually lives.
    expect(err).toContain("synap_update_session");
    expect(err).toContain("nothing was changed");
  });

  it("refuses it even alongside fields this door DOES support", () => {
    // The dangerous shape: the rest of the patch is legal, so without the guard
    // the write lands, returns 200, and the dropped field is invisible.
    expect(
      unsupportedUpdateFieldError({ progress: 50, completeOutput: "X" })
    ).toBeTruthy();
  });

  it("refuses `stages` — it shipped on tRPC and walked straight past this guard", () => {
    // FOUND BY REVIEW, NOT BY A GATE. `focus_sessions.stages` gained a writer on
    // the tRPC door (migration 0270). This door's `UpdateBodySchema` never
    // declared it, and Zod STRIPS undeclared keys — so an agent PATCHing
    // `stages` got a 200 with the full session body back and the column stayed
    // `[]`. A confident, parseable, wrong success: the very defect this file
    // was written about, reproduced by a field added months later.
    const err = unsupportedUpdateFieldError({
      stages: [{ key: "a", name: "A" }],
    });
    expect(err).toBeTruthy();
    expect(err).toContain("nothing was changed");
    // Actionable: name where the capability actually lives.
    expect(err).toContain("focusSessions.update");
  });

  it("refuses `stages` alongside legal fields too", () => {
    expect(
      unsupportedUpdateFieldError({ progress: 50, stages: [] })
    ).toBeTruthy();
  });

  it("passes a clean body, and anything that is not an object", () => {
    expect(unsupportedUpdateFieldError({ progress: 50 })).toBeNull();
    expect(unsupportedUpdateFieldError({})).toBeNull();
    expect(unsupportedUpdateFieldError(null)).toBeNull();
    expect(unsupportedUpdateFieldError("nope")).toBeNull();
  });
});
