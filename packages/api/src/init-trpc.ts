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
const isDev = process.env.NODE_ENV !== "production";

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

    return {
      ...shape,
      message:
        isInternal && !isDev ? "An unexpected error occurred" : shape.message,
    };
  },
});
