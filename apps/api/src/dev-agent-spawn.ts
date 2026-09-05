/**
 * Dev-agent spawn — the ONE process-spawn door for the coding adjunct.
 *
 * Extracted from `claude-code.ts` (the DevPlane WS handler) so the two callers
 * that need to start a coding agent share ONE implementation instead of two
 * that drift:
 *
 *   1. `claude-code.ts` — a browser opens a read-only WS and watches the PTY.
 *   2. `dev-agent-dispatch.ts` — the `external-agent` playbook executor,
 *      through the IoC slot in @synap/api (no viewer; headless).
 *
 * It owns: cwd resolution (SESSION-keyed — see dev-cwd.ts), vault-backed
 * provider env, the workspace's configured CLI launch command, and the PTY
 * lifecycle. It owns NO transport: callers supply `onData`/`onExit`.
 *
 * SECURITY: unchanged from the WS handler — callers are responsible for the
 * `workspace.settings.devplane.localTerminalEnabled` gate. This module spawns a
 * shell on the pod host and must never be reachable from an ungated door.
 */

import { db, eq } from "@synap/database";
import { workspaces } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { resolveProviderEnv } from "./local-terminal.js";
import { resolveDevCwd } from "./dev-cwd.js";

const logger = createLogger({ module: "dev-agent-spawn" });

/** Escape a string for safe inclusion inside a single-quoted shell argument. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve the launch command from the workspace's configured AI CLI tool
 * (`devplane.aiTerminal.tool`). Claude Code is seeded with the instruction as an
 * initial prompt; other tools launch bare and read SYNAP_* from env.
 */
export async function resolveLaunchCommand(
  workspaceId: string,
  instruction: string
): Promise<string> {
  let tool = "claude-code";
  let customCommand = "";
  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });
    const settings = (workspace?.settings ?? {}) as Record<string, unknown>;
    const devplane = (settings["devplane"] ?? {}) as Record<string, unknown>;
    const aiTerminal = (devplane["aiTerminal"] ?? {}) as Record<
      string,
      unknown
    >;
    if (typeof aiTerminal["tool"] === "string") tool = aiTerminal["tool"];
    if (typeof aiTerminal["customCommand"] === "string") {
      customCommand = aiTerminal["customCommand"];
    }
  } catch (err) {
    logger.warn({ err, workspaceId }, "Failed to resolve AI terminal tool");
  }

  const quoted = shellSingleQuote(instruction);
  switch (tool) {
    case "opencode":
      return "opencode";
    case "aider":
      return "aider";
    case "custom":
      return customCommand || "claude " + quoted;
    case "claude-code":
    default:
      return "claude " + quoted;
  }
}

export interface DevAgentSpawnOptions {
  workspaceId: string;
  userId: string;
  /** The focus session driving this spawn — keys the checkout path. */
  sessionId?: string | null;
  /** The prompt the CLI is seeded with. */
  instruction: string;
  /** Extra env for the child (SYNAP_TASK_ID, SYNAP_RUN_ID, …). */
  extraEnv?: Record<string, string>;
  /** Raw PTY output. */
  onData?: (chunk: string) => void;
  /** Child exited. */
  onExit?: (exitCode: number) => void;
}

export interface DevAgentProcess {
  pid: number;
  shell: string;
  cwd: string;
  launchCommand: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * Spawn the workspace's coding CLI in a PTY and auto-run it against
 * `instruction`. Throws when node-pty is unavailable or the spawn fails — a
 * caller must surface that, never report a dispatch that did not happen.
 */
export async function spawnDevAgent(
  opts: DevAgentSpawnOptions
): Promise<DevAgentProcess> {
  const { workspaceId, userId, sessionId, instruction } = opts;

  const [providerEnv, cwd, launchCommand] = await Promise.all([
    resolveProviderEnv(workspaceId, userId),
    resolveDevCwd(workspaceId, sessionId ?? null),
    resolveLaunchCommand(workspaceId, instruction),
  ]);

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

  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const ptyProcess: import("node-pty").IPty = ptyModule.spawn(shell, [], {
    name: "xterm-256color",
    cols: 220,
    rows: 50,
    cwd,
    env: {
      ...process.env,
      ...providerEnv,
      ...(opts.extraEnv ?? {}),
    } as Record<string, string>,
  });

  let killed = false;
  // Auto-run the coding agent. Delayed so the shell has finished its own init
  // before the command is typed (same 400ms the WS handler always used).
  const autoRunTimer = setTimeout(() => {
    if (!killed) ptyProcess.write(launchCommand + "\r");
  }, 400);

  if (opts.onData) {
    const onData = opts.onData;
    ptyProcess.onData((data: string) => onData(data));
  }
  ptyProcess.onExit(({ exitCode }) => {
    clearTimeout(autoRunTimer);
    opts.onExit?.(exitCode);
  });

  logger.info(
    {
      userId,
      workspaceId,
      sessionId: sessionId ?? null,
      pid: ptyProcess.pid,
      cwd,
    },
    "Dev-agent PTY spawned"
  );

  return {
    pid: ptyProcess.pid,
    shell,
    cwd,
    launchCommand,
    write: (data: string) => ptyProcess.write(data),
    resize: (cols: number, rows: number) => ptyProcess.resize(cols, rows),
    kill: () => {
      killed = true;
      clearTimeout(autoRunTimer);
      try {
        ptyProcess.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
