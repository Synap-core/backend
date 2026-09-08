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

  it("passes a clean body, and anything that is not an object", () => {
    expect(unsupportedUpdateFieldError({ progress: 50 })).toBeNull();
    expect(unsupportedUpdateFieldError({})).toBeNull();
    expect(unsupportedUpdateFieldError(null)).toBeNull();
    expect(unsupportedUpdateFieldError("nope")).toBeNull();
  });
});
