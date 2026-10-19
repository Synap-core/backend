/**
 * The boot hooks' outcome, as /health's `readiness` reads it (review R1 #4):
 * a run that THREW is `failed`, never `settled` — so a broken boot can never
 * read `ready` (`readinessFor` maps `failed` → "failed": pod-data-status.test).
 * `settled` resolves either way (waiters must not hang).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStartupTracker } from "./startup-state.js";

describe("createStartupTracker", () => {
  it("running until the hooks end; completed → settled", async () => {
    const t = createStartupTracker();
    expect(t.state()).toBe("running");
    await t.run(async () => undefined);
    expect(t.state()).toBe("settled");
  });

  it("hooks that throw → failed (rethrown), and waiters still resolve", async () => {
    const t = createStartupTracker();
    await expect(
      t.run(async () => {
        throw new Error("seedDefaultCorsOrigins: connection refused");
      })
    ).rejects.toThrow("connection refused");
    expect(t.state()).toBe("failed");
    await expect(t.settled).resolves.toBeUndefined();
  });
});

describe("startup-hooks.ts runs its hooks through the tracker (source tripwire)", () => {
  // The behaviour above is the unit; this pins that the boot USES it. It
  // reads source text: it cannot see a second, untracked run elsewhere.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "startup-hooks.ts"),
    "utf8"
  );
  it("runStartupHooks = startupTracker.run(runStartupHooksInner); no finally-flag", () => {
    expect(src).toContain("await startupTracker.run(runStartupHooksInner);");
    expect(src).toContain("startupTracker.state()");
    expect(src).not.toMatch(/finally\s*\{\s*settleStartupHooks/);
  });
});
