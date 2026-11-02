/**
 * The Control Plane base URL has ONE reading: `controlPlaneBaseUrl()`
 * (`@synap-core/core/control-plane-url`). It lives in core, whose own `test`
 * script runs nothing, so its unit test lives here.
 *
 * 1. The rule: CONTROL_PLANE_URL, else CP_URL; trimmed; a blank value is
 *    unset; trailing slashes stripped; null when neither is set.
 * 2. The tripwire: no source file outside the helper reads either variable
 *    from the environment. The copies drifted three ways (CONTROL_PLANE_URL
 *    only, CONTROL_PLANE_URL then CP_URL, CP_URL then CONTROL_PLANE_URL).
 *
 * Scan: every non-test `.ts` under `packages/*\/src` and `apps/*\/src`,
 * derived by walking the tree. It sees `env.X` and `env["X"]` / `env['X']`
 * spellings; it does NOT see a destructure (`const { CP_URL } = process.env`)
 * or a computed key built from a variable.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { controlPlaneBaseUrl } from "@synap-core/core/control-plane-url";

const ROOT = resolve(__dirname, "../../../..");
const RAW_READ = /env(?:\.|\[\s*["'])(?:CONTROL_PLANE_URL|CP_URL)\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__") {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, pkg, "src");
      try {
        if (statSync(src).isDirectory()) sourceFiles(src, files);
      } catch {
        // a package with no src/ (config-only) has nothing to read
      }
    }
  }
  return files;
}

describe("controlPlaneBaseUrl — the rule", () => {
  it("prefers CONTROL_PLANE_URL, falls back to CP_URL", () => {
    expect(
      controlPlaneBaseUrl({
        CONTROL_PLANE_URL: "https://cp.a.test",
        CP_URL: "https://cp.b.test",
      })
    ).toBe("https://cp.a.test");
    expect(controlPlaneBaseUrl({ CP_URL: "https://cp.b.test" })).toBe(
      "https://cp.b.test"
    );
  });

  it("trims, strips every trailing slash, and treats a blank value as unset", () => {
    expect(
      controlPlaneBaseUrl({ CONTROL_PLANE_URL: " https://cp.a.test// " })
    ).toBe("https://cp.a.test");
    expect(
      controlPlaneBaseUrl({
        CONTROL_PLANE_URL: "  ",
        CP_URL: "https://cp.b.test/",
      })
    ).toBe("https://cp.b.test");
  });

  it("is null when neither is set (a self-hosted pod)", () => {
    expect(controlPlaneBaseUrl({})).toBeNull();
    expect(
      controlPlaneBaseUrl({ CONTROL_PLANE_URL: "", CP_URL: " / " })
    ).toBeNull();
  });
});

describe("controlPlaneBaseUrl — the only reader of the environment", () => {
  it("the scan pattern still sees every spelling it claims to", () => {
    for (const sample of [
      "process.env.CONTROL_PLANE_URL",
      "process.env.CP_URL",
      'process.env["CONTROL_PLANE_URL"]',
      "env['CP_URL']",
    ]) {
      expect(RAW_READ.test(sample), sample).toBe(true);
    }
    expect(RAW_READ.test("process.env.CP_URL_EXTRA")).toBe(false);
  });

  it("no source file reads CONTROL_PLANE_URL or CP_URL from the environment itself", () => {
    const files = scannedFiles();
    // Non-vacuity: the walk reached the source tree (thousands of files).
    expect(files.length).toBeGreaterThan(1000);
    const offenders = files
      .filter((f) => RAW_READ.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the readers go through the helper (they did not just stop reading)", () => {
    const importers = scannedFiles().filter((f) =>
      readFileSync(f, "utf8").includes("control-plane-url")
    );
    // 15 call sites routed through it in the change that added it.
    expect(importers.length).toBeGreaterThanOrEqual(15);
  });
});
