/**
 * Existing pods must reconcile system profile contracts at worker boot. New
 * workspace creation is only a retry path, never the sole upgrade mechanism.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workersIndex = readFileSync(
  fileURLToPath(new URL("../index.ts", import.meta.url)),
  "utf8"
);

describe("system profile reconciliation at worker boot", () => {
  it("runs the idempotent reconciler before queue registration", () => {
    const registration = workersIndex.slice(
      workersIndex.indexOf("export async function registerAllWorkers")
    );

    expect(registration).toMatch(
      /await ensureSystemProfiles\(\)[\s\S]*?System profiles reconciled at worker boot/
    );
    expect(registration.indexOf("ensureSystemProfiles()")).toBeLessThan(
      registration.indexOf("Created all pg-boss queues")
    );
  });
});
