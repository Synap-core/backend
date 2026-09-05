import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * TRIPWIRE — the pod agent never constructs a shell.
 *
 * `deploy/pod-agent/server.js` runs as root-adjacent infrastructure on the
 * customer's own host: it holds the Docker socket, it is reachable over the
 * public internet at `/api/pod-agent/command`, and its ONLY gate is an ES256
 * JWT. Every legitimate command it exposes is a NAMED SCRIPT in the deploy
 * directory (`update-pod.sh`, `configure-pod.sh`, …) invoked as
 * `execFile("/bin/sh", [<script path>, ...positional args])` — argv, not a
 * command line. That shape is safe by construction: a hostile `payload` field
 * lands in `argv[n]`, never in a string the shell parses.
 *
 * The `exec` verb broke that. It built `docker exec <container> sh -c <command>`
 * from a free-form `command` payload field — a full remote shell inside the
 * pod's containers, guarded by nothing but an extra `allowExec` JWT claim that
 * NO producer ever set (verified across the whole monorepo: `allowExec`
 * appeared only on the three lines that read it, and every
 * `signPodAgentCommand()` call site in synap-control-plane-api signs one of
 * update / suspend / restore / restore-archive / archive / configure /
 * agent-update). It was a zero-caller door whose only reachable outcome was
 * abuse, so it was deleted.
 *
 * WHY THIS ASSERTS THE INVARIANT, NOT THE CURRENT SHAPE. A test pinning "there
 * are exactly 7 commands" or "`exec` is absent" pins today's list and says
 * nothing about the next verb someone adds. The real rule is narrower and
 * permanent: **no argv array in this file may pass `-c` to a shell.** A new
 * command is welcome — as a script file with positional arguments, the way all
 * seven existing ones are written.
 *
 * NOTE ON `/bin/sh`: its mere presence is NOT the violation and is deliberately
 * not banned here. `execFile("/bin/sh", [script, ...args])` is the legitimate
 * script-runner. The violation is the `-c` STRING form, in any spelling
 * (`sh -c`, `/bin/sh -c`, `bash -c`), plus `child_process.exec`/`execSync`,
 * which shell out by definition.
 */

// src/__tripwires__ → up 4 = the backend repo root. Resolved from the test
// file, never from cwd, so it scans the same file whether vitest runs from the
// repo root or from packages/api.
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".."
);
const SERVER = join(REPO_ROOT, "deploy", "pod-agent", "server.js");

/** Shell-string construction, in every spelling that reaches a `sh -c`. */
const SHELL_STRING_PATTERNS: readonly { name: string; re: RegExp }[] = [
  // An argv array element that is exactly "-c" — `["exec", c, "sh", "-c", cmd]`.
  { name: 'a "-c" argv element', re: /["'`]-c["'`]/ },
  // `sh -c` / `bash -c` written inline in one string.
  {
    name: "an inline `sh -c` command line",
    re: /\b(?:\/bin\/)?(?:ba)?sh\s+-c\b/,
  },
  // The shell-by-definition child_process entry points. `execFile`/`execFileSync`
  // /`spawn` are argv-shaped and allowed, so the boundary must exclude them.
  { name: "child_process.exec / execSync", re: /\bexec(?:Sync)?\s*\(/ },
];

describe("tripwire: the pod agent constructs no shell", () => {
  it("deploy/pod-agent/server.js contains no shell-string construction", () => {
    const src = readFileSync(SERVER, "utf8");
    const offenders = SHELL_STRING_PATTERNS.filter((p) => p.re.test(src)).map(
      (p) => p.name
    );
    expect(offenders).toEqual([]);
  });

  it("the scan actually reached the file (guards against a silent 0-byte read)", () => {
    // A path that resolves to nothing would make the assertion above pass
    // vacuously forever — the exact way source-scan tripwires rot.
    const src = readFileSync(SERVER, "utf8");
    expect(src).toContain("const COMMANDS = {");
    expect(src).toContain("/api/pod-agent/command");
  });

  it("every declared command still runs a named script, not a payload string", () => {
    // The positive half of the invariant: the dispatcher's ONLY exec path is
    // `execFile("/bin/sh", [<DEPLOY_DIR>/<cmd.script>, ...cmd.args(payload)])`.
    // A `script: null` entry is how the deleted `exec` verb smuggled itself
    // past that, so a null script is itself the violation.
    const src = readFileSync(SERVER, "utf8");
    const block = src.slice(
      src.indexOf("const COMMANDS = {"),
      src.indexOf("function configureEnvironment(")
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/script:\s*null/);
    expect(src).toContain("`${DEPLOY_DIR}/${cmd.script}`");
  });
});
