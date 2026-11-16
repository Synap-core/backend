/**
 * `synap_ask`, the ONE grammar the SDK writes and the pod reads (plan
 * 647ebfd4 option C). Rows rule out: a place read by shape instead of kind (a
 * uuid taken as a template), a permission with an `@` swallowed, a silent
 * empty ask, and an ask past the cap.
 */
import { describe, expect, it } from "vitest";
import {
  APP_ACCESS_ASK_MAX_PAIRS,
  AppAccessAskSyntaxError,
  formatSynapAsk,
  parseSynapAsk,
} from "./access-ask.js";

const SPACE = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

describe("synap_ask", () => {
  it("reads a space id and a template slug apart, and drops duplicates", () => {
    expect(
      parseSynapAsk(
        `entity.read@content-os  entity.post.create@${SPACE.toUpperCase()} entity.read@content-os`
      )
    ).toEqual([
      { permission: "entity.read", template: "content-os" },
      { permission: "entity.post.create", workspaceId: SPACE },
    ]);
  });

  it("round-trips through formatSynapAsk", () => {
    const pairs = parseSynapAsk(`entity.read@content-os share.create@${SPACE}`);
    expect(parseSynapAsk(formatSynapAsk(pairs))).toEqual(pairs);
  });

  it("refuses an empty ask, a pair with no place and a malformed place", () => {
    for (const raw of [
      "",
      "   ",
      "entity.read",
      "entity.read@",
      "@brand",
      "entity.read@Brand Library",
    ])
      expect(() => parseSynapAsk(raw), raw).toThrow(AppAccessAskSyntaxError);
  });

  it("refuses more pairs than the cap", () => {
    const many = Array.from(
      { length: APP_ACCESS_ASK_MAX_PAIRS + 1 },
      (_, i) => `entity.read@t${i}`
    ).join(" ");
    expect(() => parseSynapAsk(many)).toThrow(AppAccessAskSyntaxError);
  });
});
