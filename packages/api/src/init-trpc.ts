/**
 * tRPC instance initialization.
 *
 * Isolated in its own module to avoid circular dependency issues with tsup bundling.
 * Other files import { t } from here — no side-effect dependencies.
 */

import { randomUUID } from "crypto";
import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context.js";
import type { FieldErrors } from "@synap-core/types/errors";
import { createLogger } from "@synap-core/core";
import { isSetupRequiredLike } from "./services/proposals/setup-required-error.js";
import { readWeakDedupWire } from "./utils/weak-dedup-wire.js";
import {
  zodFieldErrors,
  zodIssuesOf,
  zodIssuesSentence,
} from "./utils/zod-field-errors.js";
import { SERVER_FAULT_MESSAGE } from "./middleware/error-egress.js";

const logger = createLogger({ module: "trpc" });

export const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error, type, path }) {
    const isInternal = shape.data.code === "INTERNAL_SERVER_ERROR";
    // THE one place a tRPC server fault is masked (audit 2026-10-28 F2). tRPC
    // 11 hands a resolver throw to `errorCatchingMiddleware` as a RESOLVED
    // result, so a mask there never ran: a driver error ("duplicate key value
    // violates unique constraint …") reached the client verbatim. Every
    // error, from every path, comes through this formatter. Same rule as the
    // Hono egress door (`middleware/error-egress.ts`): in production the
    // client gets a constant message and an `errorId`; the log keeps the rest.
    // Read per call, not at init, so the rule follows the process's NODE_ENV.
    const masked = isInternal && process.env.NODE_ENV === "production";
    const errorId = isInternal ? randomUUID() : undefined;

    if (isInternal) {
      logger.error(
        {
          err: error.cause ?? error,
          type,
          path,
          code: shape.data.code,
          errorId,
        },
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
    // Weak same-name gate. Discriminator is `cause.code`, not `cause.reasonCode`,
    // so a revision-guard CONFLICT (no such cause) does not pick this up.
    // Candidates are projected to {id,title,type}; other cause fields stay off the wire.
    const weakDedup = readWeakDedupWire(cause);
    // A STALE status move (`moveStatus` compare-and-set, `LifecycleConflictError`)
    // names the status the thing is in NOW, so the mover can say "moved
    // meanwhile to X" without parsing the message. Duck-typed on `code`.
    // Typed flat (all optional) so the error shape stays ONE object type, not
    // a union repeated in every router's generated errorShape.
    const lifecycleStale: {
      reasonCode?: string;
      expectedStatus?: string | null;
      currentStatus?: string | null;
    } =
      cause?.code === "LIFECYCLE_STALE"
        ? {
            reasonCode: "LIFECYCLE_STALE",
            expectedStatus:
              typeof cause.expectedFrom === "string"
                ? cause.expectedFrom
                : null,
            currentStatus:
              typeof cause.actual === "string" ? cause.actual : null,
          }
        : {};

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

    // A refused INPUT (tRPC's `.input()` parse, or a door that throws
    // BAD_REQUEST with the ZodError as cause) names its fields, so a form puts
    // each message under its field instead of parsing the message. Only on
    // BAD_REQUEST: a ZodError behind an INTERNAL error is the server's own
    // parse failing, and its paths are not the caller's fields. One optional
    // field, typed flat like `lifecycleStale`, never a union.
    const zodIssues =
      shape.data.code === "BAD_REQUEST" ? zodIssuesOf(cause) : null;
    const fieldErrors: { fieldErrors?: FieldErrors } = zodIssues
      ? { fieldErrors: zodFieldErrors(zodIssues) }
      : {};

    // `getErrorShape` adds `stack` when tRPC's `isDev` (fixed at init) is on;
    // a masked fault never carries one, whatever `isDev` was.
    const baseData: typeof shape.data = { ...shape.data };
    if (masked) delete baseData.stack;

    return {
      ...shape,
      // In production a server fault's message is the constant (see `masked`
      // above). Otherwise the message is the debugging text, except that a
      // refused input reads as one sentence, never zod's JSON dump of its
      // issues; a message the door wrote itself is kept. (`masked` is
      // INTERNAL only and `zodIssues` BAD_REQUEST only: they never meet.)
      message: masked
        ? SERVER_FAULT_MESSAGE
        : zodIssues && shape.message === cause?.message
          ? zodIssuesSentence(zodIssues)
          : shape.message,
      data: {
        ...baseData,
        ...(errorId ? { errorId } : {}),
        ...(typeof captureQuestionStatus === "string"
          ? { captureQuestionStatus }
          : {}),
        ...(typeof reasonCode === "string" ? { reasonCode } : {}),
        // A Library rebuild refused while the group's last bundle waits for
        // review names that bundle, so "Open the review" opens it.
        ...(typeof cause?.pendingProposalId === "string"
          ? { pendingProposalId: cause.pendingProposalId }
          : {}),
        ...(weakDedup
          ? {
              reasonCode: weakDedup.reasonCode,
              candidates: weakDedup.candidates,
              ...(weakDedup.opRef ? { opRef: weakDedup.opRef } : {}),
            }
          : {}),
        ...setupRequired,
        ...lifecycleStale,
        ...fieldErrors,
      },
    };
  },
});
