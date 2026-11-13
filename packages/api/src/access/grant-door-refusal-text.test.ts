import { describe, expect, it } from "vitest";
import {
  GRANT_DOOR_UNSUPPORTED,
  GRANT_WRITE_DOOR_UNSUPPORTED,
} from "./grant-door-fence.js";

/**
 * A scoped key refused at a door must be told what WORKS, not pointed at a
 * guide that does not exist for it (12 Nov 2026: an agent asked the person for
 * a key it did not need). The leading words stay: the CLI matches them
 * (`synap-cli` `pod-errors.ts`, /does not support scoped keys yet/).
 */
describe("the scoped-key door refusals are actionable", () => {
  for (const [name, text] of [
    ["read", GRANT_DOOR_UNSUPPORTED],
    ["write", GRANT_WRITE_DOOR_UNSUPPORTED],
  ] as const) {
    it(`${name}: names the full-access key and where the person makes it`, () => {
      expect(text).toMatch(/does not support scoped keys yet/);
      expect(text).toContain("unrestricted full access");
      expect(text).toContain("Keys page");
      expect(text).not.toContain("API keys guide");
    });
  }

  it("read: names doors that do support scoped keys", () => {
    expect(GRANT_DOOR_UNSUPPORTED).toMatch(/ask, orient or find/);
  });
});
