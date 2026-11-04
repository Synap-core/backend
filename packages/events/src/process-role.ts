/**
 * Which part of the backend this process runs (pod resilience plan P6).
 *
 * One image, one switch, `SYNAP_PROCESS_ROLE`:
 *   all    (default, also when unset or empty) the API, MCP, every pg-boss
 *          worker, the crons and the reactors in ONE process: every pod and
 *          dev setup as it ran before the split.
 *   api    HTTP and MCP, and a pg-boss that only SENDS jobs (no supervision,
 *          no cron clock): a stuck worker can no longer freeze a request.
 *   worker the pg-boss workers, their crons and the boot one-shots, behind a
 *          /health-only HTTP server for its container's healthcheck.
 *
 * Read in two places, through this one parser: apps/api's boot (which
 * starters run, which HTTP app is served) and boss.ts (the pg-boss options,
 * fixed when the instance is constructed at import). Anything else is refused,
 * never guessed: a typo must not start a backend that runs no workers.
 */

export const PROCESS_ROLES = ["all", "api", "worker"] as const;
export type ProcessRole = (typeof PROCESS_ROLES)[number];

export const PROCESS_ROLE_ENV = "SYNAP_PROCESS_ROLE";

export class InvalidProcessRoleError extends Error {
  constructor(raw: string) {
    super(
      `${PROCESS_ROLE_ENV}=${JSON.stringify(raw.slice(0, 40))} is not a process role: ` +
        `use one of ${PROCESS_ROLES.join(", ")} (unset = all)`
    );
    this.name = "InvalidProcessRoleError";
  }
}

/** Unset or blank = `all`. Throws InvalidProcessRoleError on anything else. */
export function parseProcessRole(
  raw: string | undefined = process.env[PROCESS_ROLE_ENV]
): ProcessRole {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "all";
  if ((PROCESS_ROLES as readonly string[]).includes(v)) return v as ProcessRole;
  throw new InvalidProcessRoleError(raw ?? "");
}

/**
 * pg-boss's own background loops, per role. The API of a split pod only sends
 * jobs: no maintenance (supervise) and no cron clock (schedule), so exactly
 * one process (the worker) runs them. `all` and `worker` keep pg-boss's
 * defaults (both true).
 */
export function pgBossProcessOptions(role: ProcessRole): {
  supervise: boolean;
  schedule: boolean;
} {
  const background = role !== "api";
  return { supervise: background, schedule: background };
}
