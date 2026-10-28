/**
 * The pod-level switch for anything that runs a shell on the pod host: the
 * DevPlane local terminal (`apps/api/src/local-terminal.ts`) today.
 *
 * A shell on the pod host runs as the API's own uid, so it can read the API
 * process's environment (`/proc/<pid>/environ`: DATABASE_URL, the Hub and
 * provisioning secrets) and reach every service on the compose network
 * (Kratos admin, Postgres). That is the whole pod, not one workspace. So the
 * switch is the OPERATOR's, set where the pod process is started, and never a
 * setting a signed-in person can write:
 *
 *   - `LOCAL_MODE` (`config.server.localMode`): the embedded single-user pod the
 *     desktop host starts. A Kratos-backed (cloud) pod refuses to boot with it
 *     (apps/api/src/index.ts), so it is never on for a cloud pod.
 *   - `SYNAP_LOCAL_TERMINAL=1`: an operator running a full pod on their own
 *     machine. The cloud compose never sets it. Only the exact string "1"
 *     counts, so `SYNAP_LOCAL_TERMINAL=false` stays off.
 *
 * The switch alone opens nothing: each door still requires the caller to be a
 * pod admin. It used to be `workspace.settings.devplane.localTerminalEnabled`,
 * which any member could set on a workspace they created (pre-launch audit
 * 2026-10-28, F2).
 */

import { config } from "@synap-core/core";

export const LOCAL_SHELL_ENV = "SYNAP_LOCAL_TERMINAL";

export function isLocalShellAllowed(
  env: NodeJS.ProcessEnv = process.env,
  localMode: boolean = config.server.localMode === true
): boolean {
  return localMode || env[LOCAL_SHELL_ENV] === "1";
}
