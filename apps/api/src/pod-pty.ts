/**
 * Pod PTY — the ONE place this server spawns a shell.
 *
 * Both pod spawners (`local-terminal.ts`, the interactive DevPlane terminal,
 * and `dev-agent-spawn.ts`, the coding-agent launcher) go through
 * `spawnPodPty`. A tripwire (`pod-pty.one-door.test.ts`) fails if any other
 * file in this package imports node-pty.
 *
 * SECURITY — why the env is an allowlist:
 * the child is a shell an agent (or a pre-typed command) drives. Spreading
 * `process.env` into it handed the agent every pod secret: database URL,
 * Kratos/Hub keys, storage credentials. The child now gets only what a login
 * shell needs to find binaries and its home directory, plus the caller's
 * explicit `extraEnv` (vault-resolved provider keys, SYNAP_* run ids).
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "pod-pty" });

/** Env keys a spawned shell inherits from the pod process. Nothing else does. */
export const POD_PTY_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TZ",
] as const;

export function buildPodPtyEnv(
  source: NodeJS.ProcessEnv,
  extraEnv: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = { TERM: "xterm-256color" };
  for (const key of POD_PTY_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...extraEnv };
}

/**
 * A command pre-typed into a shell for the user to review must not be able to
 * submit itself. Strips every C0 control character and DEL — CR/LF would press
 * Enter, ESC could start a bracketed-paste or terminal escape sequence. Tabs
 * become spaces so the reviewed text keeps its shape.
 */
export function sanitizePresetCommand(command: string): string {
  // eslint-disable-next-line no-control-regex
  return command.replace(/\t/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
}

export interface PodPtyOptions {
  cwd: string;
  extraEnv?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PodPty {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  pty: import("node-pty").IPty;
  shell: string;
}

/**
 * Spawn a login shell in a PTY with an allowlisted env. Throws when node-pty is
 * unavailable or the spawn fails — the caller surfaces that to its transport.
 */
export async function spawnPodPty(opts: PodPtyOptions): Promise<PodPty> {
  // Lazy-import node-pty so the module only loads when needed.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let ptyModule: typeof import("node-pty");
  try {
    ptyModule = await import("node-pty");
  } catch (err) {
    logger.error({ err }, "node-pty not available");
    throw new Error("node-pty not installed on this server");
  }

  const shell = process.env["SHELL"] ?? "/bin/bash";
  const pty = ptyModule.spawn(shell, [], {
    name: "xterm-256color",
    cols: opts.cols ?? 220,
    rows: opts.rows ?? 50,
    cwd: opts.cwd,
    env: buildPodPtyEnv(process.env, opts.extraEnv),
  });
  return { pty, shell };
}
