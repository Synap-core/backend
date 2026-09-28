import { describe, it, expect } from "vitest";
import { onApiKeysRevoked, revokeApiKeys } from "./api-key-revocation.js";
import { eq } from "drizzle-orm";
import { apiKeys } from "../schema/index.js";

/** A fake executor that records the UPDATE and when it resolved. */
function fakeExecutor(log: string[]) {
  return {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            log.push(`update:${values.isActive}:${values.revokedAt instanceof Date}:${values.revokedReason}`);
            return [{ id: "k1" }];
          },
        }),
      }),
    }),
  };
}

describe("revokeApiKeys — the ONE revoke door", () => {
  it("revokes, THEN drops every registered cache, and returns the ids", async () => {
    const log: string[] = [];
    const off = onApiKeysRevoked(() => log.push("cache-cleared"));
    const rows = await revokeApiKeys(fakeExecutor(log), {
      where: eq(apiKeys.id, "k1"),
      revokedBy: "u1",
      reason: "test",
    });
    off();
    expect(rows).toEqual([{ id: "k1" }]);
    expect(log).toEqual(["update:false:true:test", "cache-cleared"]);
  });

  it("an unregistered cache is no longer called", async () => {
    const log: string[] = [];
    const off = onApiKeysRevoked(() => log.push("cache-cleared"));
    off();
    await revokeApiKeys(fakeExecutor(log), { where: eq(apiKeys.id, "k1"), reason: "t" });
    expect(log).toEqual(["update:false:true:t"]);
  });

  it("refuses to run without a where clause", async () => {
    await expect(
      revokeApiKeys(fakeExecutor([]), { where: undefined, reason: "x" })
    ).rejects.toThrow(/where clause is required/);
  });
});
