/**
 * The top bar's ⚠ must not outlive the codes, and a failed read must not
 * stick: the cache behind `useRecoveryCodesState`, driven through its real
 * read/invalidate/subscribe — only the pod's `/status` answer is faked.
 */
import { describe, expect, it, vi } from "vitest";
import { createRecoveryCodesStateCache } from "./recovery-codes-nudge";

const answer = (set: boolean) => ({ ok: true, data: { recoveryCodes: { set } } });
const failed = { ok: false };

describe("recovery-codes state cache", () => {
  it("one read per page load while it succeeds", async () => {
    const read = vi.fn(async () => answer(false));
    const cache = createRecoveryCodesStateCache(read);
    expect(await cache.read()).toBe("not_set");
    expect(await cache.read()).toBe("not_set");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("invalidate after creating codes → the next read goes to the pod (⚠ clears)", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(answer(false))
      .mockResolvedValueOnce(answer(true));
    const cache = createRecoveryCodesStateCache(read);
    expect(await cache.read()).toBe("not_set");
    cache.invalidate();
    expect(await cache.read()).toBe("set");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("invalidate tells mounted readers to re-read", () => {
    const cache = createRecoveryCodesStateCache(async () => answer(true));
    const listener = vi.fn();
    const off = cache.subscribe(listener);
    cache.invalidate();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    cache.invalidate();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a failed read is never cached — the next mount retries", async () => {
    const read = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(answer(true));
    const cache = createRecoveryCodesStateCache(read);
    expect(await cache.read()).toBe("unknown");
    expect(await cache.read()).toBe("set");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a thrown read is 'unknown', and is not cached either", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(answer(false));
    const cache = createRecoveryCodesStateCache(read);
    expect(await cache.read()).toBe("unknown");
    expect(await cache.read()).toBe("not_set");
  });
});
