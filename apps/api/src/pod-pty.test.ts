/**
 * Two invariants:
 *  1. A shell this pod spawns never inherits a pod secret — only the allowlist
 *     plus what the caller passes explicitly.
 *  2. A command pre-typed for the user to review cannot submit itself.
 *
 * And one door: nothing else in apps/api imports node-pty. The scanned set is
 * DERIVED (every .ts file under src), so a new spawner joins it by existing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {} }),
}));

import {
  POD_PTY_ENV_ALLOWLIST,
  buildPodPtyEnv,
  sanitizePresetCommand,
} from "./pod-pty.js";

describe("buildPodPtyEnv", () => {
  const podEnv = {
    HOME: "/home/pod",
    PATH: "/usr/bin",
    SHELL: "/bin/zsh",
    DATABASE_URL: "postgres://secret",
    HUB_API_KEY: "hub-secret",
    ANTHROPIC_API_KEY: "pod-level-key",
    KRATOS_ADMIN_URL: "http://kratos",
  } as NodeJS.ProcessEnv;

  it("drops every pod variable outside the allowlist", () => {
    const env = buildPodPtyEnv(podEnv);
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["HUB_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["KRATOS_ADMIN_URL"]).toBeUndefined();
  });

  it("keeps what a shell needs and what the caller passes explicitly", () => {
    const env = buildPodPtyEnv(podEnv, {
      ANTHROPIC_API_KEY: "vault-key",
      SYNAP_RUN_ID: "r1",
    });
    expect(env).toEqual({
      TERM: "xterm-256color",
      HOME: "/home/pod",
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
      ANTHROPIC_API_KEY: "vault-key",
      SYNAP_RUN_ID: "r1",
    });
  });

  it("allowlist names no secret-shaped key", () => {
    for (const key of POD_PTY_ENV_ALLOWLIST) {
      expect(key).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD|URL|DATABASE/);
    }
  });
});

describe("sanitizePresetCommand", () => {
  it("cannot press Enter: CR and LF are removed", () => {
    expect(sanitizePresetCommand("ls\nrm -rf ~\r")).toBe("lsrm -rf ~");
  });

  it("removes ESC so no terminal escape or bracketed paste can start", () => {
    expect(sanitizePresetCommand("a\x1b[201~b")).toBe("a[201~b");
  });

  it("keeps an ordinary command intact, tabs as spaces", () => {
    expect(sanitizePresetCommand("claude 'fix the\tbutton'")).toBe(
      "claude 'fix the button'"
    );
  });
});

describe("one PTY door", () => {
  const srcDir = fileURLToPath(new URL(".", import.meta.url));

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
    });
  }

  const files = walk(srcDir);
  const NODE_PTY = /(?:from|import\()\s*["']node-pty["']/;

  it("scans a plausible number of files (non-vacuous)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("pod-pty.ts"))).toBe(true);
  });

  it("the pattern still sees the import it hunts", () => {
    expect(
      NODE_PTY.test(readFileSync(join(srcDir, "pod-pty.ts"), "utf8"))
    ).toBe(true);
  });

  it("only pod-pty.ts imports node-pty", () => {
    const importers = files
      .filter((f) => NODE_PTY.test(readFileSync(f, "utf8")))
      .map((f) => relative(srcDir, f));
    expect(importers).toEqual(["pod-pty.ts"]);
  });
});
