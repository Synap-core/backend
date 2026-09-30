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
import { isSetupRequiredLike } from "./services/proposals/setup-required-error.js";

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
    const cause = error.cause as Record<string, unknown> | undefined;
    const captureQuestionStatus = cause?.captureQuestionStatus;
    // A typed refusal names its machine code the same way (`reasonCode`, e.g.
    // `NO_NEXT_RUNG` — read by `isNoNextRungError`, @synap-core/types).
    const reasonCode = cause?.reasonCode;

    // A capability install that needs a HUMAN before it can apply is converted
    // by `errorCatchingMiddleware` into a coded TRPCError whose `cause` is the
    // original `SetupRequiredError`. Forward the SAME value-free payload the Hub
    // REST `POST /capabilities/apply` door returns (400/412 + body), so a tRPC
    // client renders the setup card from `error.data.failureClass` instead of
    // parsing the message. Guarded by the ONE duck-typed reader, so only the
    // value-free contract is ever exposed.
    const setupRequired = isSetupRequiredLike(cause)
      ? {
          failureClass: cause.failureClass,
          missingFields: cause.missingFields,
          ...(cause.connection !== undefined
            ? { connection: cause.connection }
            : {}),
        }
      : {};

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
        ...setupRequired,
      },
    };
  },
});
