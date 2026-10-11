/** The mint door's cap is the ONE constant the editor validates against. */
import { describe, expect, it } from "vitest";
import { MAX_GRANT_PERMISSIONS } from "@synap-core/types/grants";
import { GrantInputSchema } from "./key-grant.js";

const perms = (n: number) =>
  Array.from({ length: n }, (_, i) => `entity.k${i}.read`);

describe("GrantInputSchema.permissions", () => {
  it("accepts exactly MAX_GRANT_PERMISSIONS and refuses one more", () => {
    expect(MAX_GRANT_PERMISSIONS).toBe(128);
    expect(
      GrantInputSchema.safeParse({ permissions: perms(MAX_GRANT_PERMISSIONS) })
        .success
    ).toBe(true);
    expect(
      GrantInputSchema.safeParse({
        permissions: perms(MAX_GRANT_PERMISSIONS + 1),
      }).success
    ).toBe(false);
  });
});
