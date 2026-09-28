/**
 * tRPC instance initialization.
 *
 * Isolated in its own module to avoid circular dependency issues with tsup bundling.
 * Other files import { t } from here — no side-effect dependencies.
 */

import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "trpc" });

export const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error, type, path }) {
    const isInternal = shape.data.code === "INTERNAL_SERVER_ERROR";

    if (isInternal) {
      logger.error(
        { err: error.cause ?? error, type, path, code: shape.data.code },
        "Internal server error in tRPC procedure"
      );
    } else {
      logger.debug(
        { type, path, code: shape.data.code, message: shape.message },
        "tRPC procedure error"
      );
    }

    // A capture follow-up CONFLICT names the question's status as a stable,
    // machine-readable field, so clients never parse the message text.
    const captureQuestionStatus = (
      error.cause as { captureQuestionStatus?: unknown } | undefined
    )?.captureQuestionStatus;
    // A typed refusal names its machine code the same way (`reasonCode`, e.g.
    // `NO_NEXT_RUNG` — read by `isNoNextRungError`, @synap-core/types).
    const reasonCode = (error.cause as { reasonCode?: unknown } | undefined)
      ?.reasonCode;

    return {
      ...shape,
      // Always expose the error message — clients need it for debugging.
      // Stack traces are NOT included (only the message string).
      message: shape.message,
      data: {
        ...shape.data,
        ...(typeof captureQuestionStatus === "string"
          ? { captureQuestionStatus }
          : {}),
        ...(typeof reasonCode === "string" ? { reasonCode } : {}),
      },
    };
  },
});
