/**
 * Shared logger instance for the automation-executor module family (the main
 * worker file plus every `steps/*` / helper module split out of it). Kept as
 * ONE leaf so every extracted module logs under the same `module:
 * "automation-executor"` tag the original monolith used — splitting the file
 * must not change what an operator greps for in the logs.
 */
import { createLogger } from "@synap-core/core";

export const logger: ReturnType<typeof createLogger> = createLogger({
  module: "automation-executor",
});
