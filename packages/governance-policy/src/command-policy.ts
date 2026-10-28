/**
 * COMMAND POLICY — the one content check for a shell command the pod runs
 * (`POST /api/hub/commands/execute`, `command.execute`).
 *
 * Every door that can put a command string on the way to `/bin/sh` reads THIS
 * function: the Hub door when the command is filed, the revise core when a
 * pending `command/execute` proposal's payload is revised, and the jobs
 * materializer right before an approved command runs. It used to live only in
 * the Hub door, so a revised payload (audit 2026-10-28, F1) reached the shell
 * with no check at all.
 *
 * It is a denylist, so it is a floor, not a sandbox: the switch below
 * (`isPodShellAllowed`) is what keeps the door shut on a pod that never opted
 * in.
 */

/** Commands refused whatever the governance says. */
export const BLOCKED_COMMAND_PATTERNS: readonly RegExp[] = [
  // Filesystem destruction
  /\brm\s+.*-[a-z]*r[a-z]*f/i, // rm -rf (any flags order)
  /\brm\s+.*\s+\/($|\s)/i, // rm anything at root
  /\brm\s+-[a-z]*r/i, // any recursive rm

  // System control
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\binit\s+[0-6]\b/i,
  /\bsystemctl\s+(halt|poweroff|reboot)\b/i,

  // Disk/device destruction
  /\bmkfs\b/i,
  /\bdd\b.*\bof\s*=\s*\/dev\//i, // dd to block devices
  />\s*\/dev\/sd[a-z]/i, // write to block devices
  />\s*\/dev\/nvme/i,

  // Fork bombs and resource exhaustion
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, // :(){ :|:& };:
  /\bfork\s*bomb/i,
  /while\s+true.*do/i, // while true; do ... (infinite loops)
  /\byes\s*\|/i, // yes | ... (can flood stdin)

  // Remote code execution via pipe
  /\bcurl\b.*\|\s*(bash|sh|zsh|python|perl|ruby)\b/i,
  /\bwget\b.*\|\s*(bash|sh|zsh|python|perl|ruby)\b/i,
  /\bcurl\b.*>\s*[^\s]+\s*&&\s*(bash|sh|chmod)/i, // curl > file && bash/chmod

  // Credential / key theft
  /\bcat\b.*\/(\.ssh|\.gnupg|\.aws\/credentials)/i,
  /\bcp\b.*\/(\.ssh|\.gnupg|\.aws\/credentials)/i,

  // The pod's own secrets (audit F8). The child gets a filtered env, but the
  // API process's environment (DATABASE_URL, the vault master key, Kratos
  // secrets) is readable through /proc, and a bare `env` / `printenv` or an
  // inline interpreter is the shortest way to it or to the database.
  /\/proc\//i,
  /\benviron\b/i,
  /\bprintenv\b/i,
  /(^|[\s;&|(])env\s*($|[;&|>)])/i, // bare `env`, `env | …`, `env > f`
  /\bnode\b[^;&|]*\s(-e|-p|--eval|--print)\b/i,
  /\bpsql\b/i,

  // Environment manipulation that could affect the host
  /\bexport\b.*\b(PATH|LD_PRELOAD|LD_LIBRARY_PATH)\s*=/i,
  /\bchmod\s+[0-7]*[2367][0-7]*\s+\//i, // chmod making system files world-writable
  /\bchown\b.*\s+\/($|\s)/i, // chown on root

  // Container/VM escape attempts
  /\bnsenter\b/i,
  /\bdocker\s+run\b.*--privileged/i,
  /\bmount\b.*\/dev\//i,

  // Network exfiltration of system files
  /\b(nc|ncat|netcat)\b.*<\s*\//i, // piping system files to netcat
];

/** Shell substitution hides a command from every pattern above. */
const SUBSTITUTION = [/`[^`]*`/, /\$\(/];

export const COMMAND_SUBSTITUTION_REFUSAL =
  "Shell substitution (backticks, $()) is not allowed. Run commands directly.";
export const COMMAND_BLOCKED_REFUSAL =
  "This command is blocked by security policy";

/**
 * Why this command may not run, or `null` when the content check passes.
 * A missing or non-string command is refused too: there is nothing to judge.
 */
export function commandPolicyRefusal(command: unknown): string | null {
  if (typeof command !== "string" || command.trim() === "") {
    return "command is required";
  }
  if (SUBSTITUTION.some((re) => re.test(command))) {
    return COMMAND_SUBSTITUTION_REFUSAL;
  }
  if (BLOCKED_COMMAND_PATTERNS.some((re) => re.test(command))) {
    return COMMAND_BLOCKED_REFUSAL;
  }
  return null;
}

/**
 * THE SWITCH (audit F8): a shell on the pod host runs as the API's own uid
 * inside the backend container, so it can read every secret the pod holds and
 * reach every service on its network. No first-party flow needs it at launch,
 * so it is OFF unless the OPERATOR turned it on where the pod process starts:
 *
 *   - `localMode` (`config.server.localMode`): the embedded single-user pod the
 *     desktop host starts; a cloud pod refuses to boot with it.
 *   - `SYNAP_LOCAL_TERMINAL=1`: an operator running a full pod on their own
 *     machine. Only the exact string "1" counts.
 *
 * The same switch as the DevPlane local terminal (backend#400): one knob for
 * "anything that runs a shell on the pod host". A signed-in person cannot set
 * it, and governance still applies when it is on (`command.execute` is the
 * ARBITRARY_EXECUTION floor: always a proposal).
 */
export const POD_SHELL_ENV = "SYNAP_LOCAL_TERMINAL";

export function isPodShellAllowed(
  env: Record<string, string | undefined>,
  localMode: boolean
): boolean {
  return localMode || env[POD_SHELL_ENV] === "1";
}

export const POD_SHELL_OFF_REFUSAL =
  "Running commands on the pod host is off on this pod. The operator turns it on where the pod starts (SYNAP_LOCAL_TERMINAL=1).";
