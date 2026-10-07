/**
 * The ONE derivation of an Application's reach.
 *
 * Three surfaces render this (pod-admin, relay, the browser) and each maps the
 * FACTS into its own UI type, so this file pins the facts themselves. The
 * discriminating cases are the two the surfaces deliberately differ on, and the
 * one they must never confuse:
 *
 *   - `appReachText` is "" with no live grant (the browser CARD stays quiet and
 *     lets its state chip speak) while `appReach` falls back to "No access yet"
 *     (pod-admin/relay print a line). Same facts, two renderings — pinning only
 *     one would let the other silently change.
 *   - A REVOKED app reads "Access removed", never "No access yet": revoke killed
 *     its keys, so it has no LIVE reach. "No access yet" would claim it never
 *     had any, which is a different and false statement.
 */
import { describe, expect, it } from "vitest";
import {
  appMode,
  appReach,
  appReachLines,
  appReachText,
  type AppStateLike,
} from "./app-view.js";

const GRANT = {
  permissions: ["entity.person.create"],
  workspaceIds: ["ws-1"],
  projectIds: null,
  entityIds: null,
};

const app = (over: Partial<AppStateLike> = {}): AppStateLike => ({
  revoked_at: null,
  grants: [GRANT],
  ...over,
});

describe("reach — the two renderings, and the line that must never blur", () => {
  it("a revoked app reads 'Access removed', NOT 'No access yet'", () => {
    const revoked = app({ revoked_at: "2026-10-06T13:00:00.000Z", grants: [] });
    expect(appReachText(revoked)).toBe("Access removed");
    expect(appReach(revoked)).toBe("Access removed");
    // The distinction the pod-admin docblock exists to protect.
    expect(appReach(revoked)).not.toBe("No access yet");
  });

  it("with no grant, the CARD stays quiet while the LINE states it", () => {
    const empty = app({ grants: [] });
    // Deliberate divergence, not an accident: browser's card renders the reach
    // span AND a state chip, so a fallback here would say "No access yet" twice.
    expect(appReachText(empty)).toBe("");
    // pod-admin and relay print a line, so the fallback lives in `appReach`.
    expect(appReach(empty)).toBe("No access yet");
  });

  it("a live grant renders in the shared what · where words", () => {
    expect(appReachLines([GRANT])).toEqual(["Create People · 1 Space"]);
    expect(appReachText(app())).toBe("Create People · 1 Space");
  });

  it("joins several grants with '; '", () => {
    const two = appReachText(app({ grants: [GRANT, { ...GRANT, workspaceIds: ["ws-2"] }] }));
    expect(two.split("; ")).toHaveLength(2);
  });

  it("appReachLines is the SAME derivation as the text, not a second one", () => {
    const lines = appReachLines([GRANT]);
    expect(appReachText(app())).toBe(lines.join("; "));
  });
});

describe("appMode", () => {
  it("names the one implemented mode in words", () => {
    expect(appMode("specific")).toBe("Specific access");
  });

  it("humanizes an unknown mode rather than leaking a raw token", () => {
    expect(appMode("some_new_mode")).not.toBe("some_new_mode");
  });
});
