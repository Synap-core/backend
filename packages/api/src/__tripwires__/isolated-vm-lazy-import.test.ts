/**
 * TRIPWIRE — `isolated-vm` must never be imported at module scope.
 *
 * WHY THIS EXISTS (a production outage, 2026-08-01):
 *
 * `isolated-vm` is a NATIVE addon that ships no musl prebuild. The pod runs on
 * `node:20-alpine`. A single static `import ivm from "isolated-vm"` in
 * `services/skills/run-skill-in-sandbox.ts` therefore executed on every boot —
 * because `services/capabilities/execute-capability.ts` imports that module
 * statically — and the container crash-looped:
 *
 *   Error: No native build was found for platform=linux arch=x64 runtime=node
 *   abi=115 uv=1 libc=musl node=20.20.2
 *     loaded from: /app/api/node_modules/.pnpm/isolated-vm@6.1.2/…
 *
 * The `SANDBOX_LOCAL === "1"` flag did NOT protect the pod: it gates the CALL,
 * and a call-site flag can never gate a STATIC import — the module graph is
 * resolved before any flag is read. Only a dynamic `import()` defers the load.
 *
 * `deploy/Dockerfile.api` asserts the dep is inert while the flag is off. That
 * claim is only TRUE while the import stays lazy — which is what this test
 * enforces. A comment cannot enforce an invariant; this can.
 *
 * If this test fails: do not "fix" it by compiling the addon into the image
 * unless you actually intend to turn `SANDBOX_LOCAL` on. Restore the lazy
 * `loadIvm()` helper instead.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(__dirname, "..");

/** Every `.ts` file under `packages/api/src`, excluding this tripwire itself. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      collectSourceFiles(full, acc);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (full.endsWith("isolated-vm-lazy-import.test.ts")) continue;
    acc.push(full);
  }
  return acc;
}

/**
 * A STATIC import of the module — `import … from "isolated-vm"` or
 * `require("isolated-vm")`. Deliberately does NOT match `import type …`
 * (erased at compile time, so it emits no runtime load) nor the dynamic
 * `import("isolated-vm")` form, which is exactly what we want callers to use.
 */
const STATIC_IMPORT_RE =
  /(?:^|\n)\s*import\s+(?!type\s)[^;\n]*from\s*["']isolated-vm["']|require\(\s*["']isolated-vm["']\s*\)/;

describe("isolated-vm is never imported at module scope", () => {
  const files = collectSourceFiles(SRC_ROOT);

  // Self-guard: a scan that silently collects nothing would pass vacuously.
  it("scans a non-empty set of source files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no source file statically imports isolated-vm", () => {
    const offenders = files.filter((f) =>
      STATIC_IMPORT_RE.test(readFileSync(f, "utf8"))
    );
    expect(
      offenders.map((f) => f.slice(SRC_ROOT.length + 1)),
      "isolated-vm has no musl prebuild — a static import crash-loops the pod on boot. " +
        "Use the lazy loadIvm() helper in services/skills/run-skill-in-sandbox.ts."
    ).toEqual([]);
  });

  it("the sandbox module still reaches the addon lazily", () => {
    // Negative control: proves the scan above is not passing merely because
    // nothing references isolated-vm at all any more.
    const sandbox = readFileSync(
      join(SRC_ROOT, "services/skills/run-skill-in-sandbox.ts"),
      "utf8"
    );
    expect(sandbox).toMatch(/import\(\s*["']isolated-vm["']\s*\)/);
  });
});
